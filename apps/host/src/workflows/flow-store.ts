import { shallowRef } from 'vue'
import type { Disposable } from '@lc/kernel'
import type { FlowDefinition, FlowEdge, FlowNode, FlowSettings } from '@lc/schema'
import {
  DEFAULT_FLOW_SETTINGS,
  FLOW_INITIAL_VERSION,
  FLOW_TRIGGER,
  createFlowNode,
  hasBlockingIssue,
  validateFlow,
} from '@lc/schema'
import { resolveProjectId } from '../projects/project-model'
import { createSeedFlow } from './flow-template'

/**
 * 流程图存储。
 *
 * 图是可独立发版的执行单元，所以它的生命周期与「页面文档」脱钩：页面在自己的
 * `connection.flowId` 上写住要跑哪张图，运行时按 id 取**已发布**版本执行。
 * 目前没有后端，存储落在 localStorage；接服务端时只需替换本文件的读写实现，
 * 与 `functions/global-functions.ts` 是同一种取舍。
 */

/** 新建流程的输入 */
export interface FlowDraftInput {
  /** 流程名；空白串会被拒绝而不是落库成空标题 */
  name: string
  /** 流程说明 */
  description?: string
  /** 是否附带示例图；缺省只放一个触发节点 */
  withSeed?: boolean
  /** 归属项目 id；由调用方从当前项目路由取，事件键只在同项目内互相拦截 */
  projectId: string
}

const STORAGE_KEY = 'lc.flows.v1'
const listeners = new Set<() => void>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPosition(value: unknown): value is FlowNode['position'] {
  if (!isRecord(value)) return false
  return (
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  )
}

/**
 * 存储内容来自用户可编辑的 localStorage，读入时逐字段收窄。
 *
 * 只收窄到「能安全交给执行器与画布」的程度：config 的具体形状由各节点类型的字段
 * 声明负责，这里不重复一遍，否则新增一种节点类型就要改两处。
 */
function isFlowNode(value: unknown): value is FlowNode {
  if (!isRecord(value)) return false

  return (
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.type === 'string' &&
    value.type !== '' &&
    isPosition(value.position) &&
    isRecord(value.config) &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.description === undefined || typeof value.description === 'string')
  )
}

function isFlowSettings(value: unknown): value is FlowSettings {
  if (!isRecord(value)) return false

  return (
    typeof value.timeoutSeconds === 'number' &&
    Number.isFinite(value.timeoutSeconds) &&
    typeof value.maxConcurrency === 'number' &&
    Number.isFinite(value.maxConcurrency)
  )
}

function isFlow(value: unknown): value is FlowDefinition {
  if (!isRecord(value)) return false

  const nodesOk =
    isRecord(value.nodes) &&
    Object.values(value.nodes).every(isFlowNode) &&
    Object.entries(value.nodes).every(([key, node]) => (node as FlowNode).id === key)
  const edgesOk =
    isRecord(value.edges) &&
    Object.values(value.edges).every(
      (edge) =>
        isRecord(edge) &&
        typeof edge.id === 'string' &&
        typeof edge.source === 'string' &&
        typeof edge.target === 'string',
    )

  return (
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.name === 'string' &&
    (value.status === 'draft' || value.status === 'published') &&
    typeof value.version === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.projectId === undefined || typeof value.projectId === 'string') &&
    nodesOk &&
    edgesOk &&
    isFlowSettings(value.settings)
  )
}

function readStorage(): FlowDefinition[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return [createSeedFlow()]

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    const ids = new Set<string>()
    return parsed.filter((item): item is FlowDefinition => {
      if (!isFlow(item)) return false
      if (ids.has(item.id)) return false
      ids.add(item.id)
      return true
    })
  } catch (error) {
    console.error('[host] 读取流程图存储失败，按空列表处理', error)
    return []
  }
}

function persist(entries: readonly FlowDefinition[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch (error) {
    // 隐私模式或配额不足时只丢持久化，当前会话里的图仍然可编辑
    console.error('[host] 保存流程图到 localStorage 失败', error)
  }
}

const state = shallowRef<readonly FlowDefinition[]>(readStorage())

/** 流程列表；只读约定由调用方遵守，写入必须走本模块的 save / publish / remove */
export const flows = state

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function commit(next: readonly FlowDefinition[]): void {
  state.value = next
  persist(next)
  notify()
}

/** 生成稳定 id；只要求跨刷新唯一，事件绑定引用的就是它 */
function createFlowId(): string {
  return `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 发布版本号推进：抬一位次版本号。
 *
 * 事件按 id 绑定图，换一张图（新增节点、改分支）对绑定方是行为变化，抬主版本号
 * 又会让「改个错别字」看起来像破坏性变更。真正的版本策略要等服务端版本表，
 * 这里只保证同一张图的版本号单调可比。
 *
 * @param version 当前版本号，形如 `1.0.0`
 * @returns 下一个版本号；输入不是三段数字时回到初始版本
 */
export function nextFlowVersion(version: string): string {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part)))
    return FLOW_INITIAL_VERSION

  const [major, minor] = parts as [number, number]

  return `${major}.${minor + 1}.0`
}

/**
 * 新建一张流程。
 *
 * 只落一个触发节点而不是空图：右栏与画布的首屏都要有可选中对象，空图会让
 * 「新建」看起来像没生效。
 *
 * 建完直接入库而不是只返回对象：调用方拿到 id 就跳编辑器，编辑器按 id 从存储里取图。
 * 不落库的话新建完立刻是「流程不存在」，整张图根本无从画起。
 *
 * 归属由调用方给：创建入口都在项目路由下，图要落在当前项目里，
 * 之后的事件冲突拦截才只跟同项目的图比。
 *
 * @throws 名称为空时抛错
 */
export function createFlow(input: FlowDraftInput): FlowDefinition {
  const name = input.name.trim()
  if (name === '') throw new Error('[host] 流程必须命名')

  const now = new Date().toISOString()
  const nodes: Record<string, FlowNode> = {}
  const edges: Record<string, FlowEdge> = {}

  if (input.withSeed) {
    const seeded = createSeedFlow()
    Object.assign(nodes, seeded.nodes)
    Object.assign(edges, seeded.edges)
  } else {
    const trigger = createFlowNode('trigger.page', 'node-trigger', { x: 320, y: 80 })
    trigger.name = '开始'
    nodes[trigger.id] = trigger
  }

  return saveFlow({
    id: createFlowId(),
    name,
    description: input.description?.trim() || undefined,
    projectId: input.projectId,
    status: 'draft',
    version: FLOW_INITIAL_VERSION,
    updatedAt: now,
    nodes,
    edges,
    settings: { ...DEFAULT_FLOW_SETTINGS },
  })
}

/**
 * 保存一张图（草稿写入）。
 *
 * 不做发布校验：草稿的意义就是允许半成品存在，环与缺分支在发布时才会被拦下。
 * 名称为空是唯一的硬拒绝，因为列表与工具栏都要靠它显示。
 *
 * @throws 名称为空时抛错
 */
export function saveFlow(flow: FlowDefinition): FlowDefinition {
  const name = flow.name.trim()
  if (name === '') throw new Error('[host] 流程必须命名')

  const saved: FlowDefinition = { ...flow, name, updatedAt: new Date().toISOString() }
  const exists = state.value.some((item) => item.id === saved.id)
  const next = exists
    ? state.value.map((item) => (item.id === saved.id ? saved : item))
    : [...state.value, saved]

  commit(next)
  return saved
}

/**
 * 发布一张图。
 *
 * 只有一道闸门：`validateFlow` 不能有阻断问题。
 *
 * 以前这里还要拦「同一事件键被两张已发布的图抢用」。绑定改由页面的
 * `connection.flowId` 持有之后，这类冲突在结构上不可能发生：一个事件只有一个字段，
 * 装得下一张图；而一张图被多少个事件引用都不冲突——它跑的永远是同一份内容。
 * 少掉这道闸门不是放松校验，是那条不变式已经不需要有人守了。
 *
 * @throws 校验不通过时抛错，错误文案可直接展示给用户
 */
export function publishFlow(id: string): FlowDefinition {
  const current = state.value.find((item) => item.id === id)
  if (!current) throw new Error(`[host] 待发布的流程不存在: ${id}`)

  const issues = validateFlow(current)
  if (hasBlockingIssue(issues)) {
    const first = issues.find((issue) => issue.severity === 'error')
    throw new Error(`[host] 流程不能发布：${first?.message ?? '存在阻断问题'}`)
  }

  const published: FlowDefinition = {
    ...current,
    status: 'published',
    version:
      current.status === 'published' ? nextFlowVersion(current.version) : current.version,
  }

  commit(state.value.map((item) => (item.id === id ? published : item)))
  return published
}

/** 删除一张图；id 不存在时不做任何事 */
export function removeFlow(id: string): void {
  const next = state.value.filter((item) => item.id !== id)
  if (next.length === state.value.length) return
  commit(next)
}

/** 按 id 取图 */
export function getFlow(id: string): FlowDefinition | undefined {
  return state.value.find((item) => item.id === id)
}

/**
 * 在指定项目里按 id 取已发布的图。
 *
 * 只认 `published`：草稿参与执行会让「正在编辑的图」抢先跑起来，作者在设计器里
 * 改一半的分支就会落到真实页面上。
 *
 * 项目作用域仍然要卡：页面写下的 `flowId` 只是个字符串，把 B 项目的图 id 粘到 A 项目的
 * 页面上照样能存进去。少这一层，「我在 B 画的流程在 A 的页面上跑了」就又回来了。
 *
 * @param projectId 当前项目 id
 * @param flowId 页面连接上引用的图 id
 */
export function getPublishedFlowById(
  projectId: string,
  flowId: string,
): FlowDefinition | undefined {
  return state.value.find(
    (flow) =>
      flow.id === flowId &&
      flow.status === 'published' &&
      resolveProjectId(flow.projectId) === projectId,
  )
}

/** 指定项目里全部图（含草稿）；绑定下拉的状态标注与页面校验都据此区分「不存在」与「还是草稿」 */
export function listProjectFlows(projectId: string): readonly FlowDefinition[] {
  return state.value.filter((flow) => resolveProjectId(flow.projectId) === projectId)
}

/** 订阅流程列表变更；返回注销句柄 */
export function onFlowsChange(listener: () => void): Disposable {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}

/** 生成一个新节点 id；同一张图内唯一即可 */
export function nextNodeId(flow: FlowDefinition): string {
  let index = Object.keys(flow.nodes).length + 1

  while (flow.nodes[`node-${index}`]) index += 1

  return `node-${index}`
}

/** 生成一条新连线 id */
export function nextEdgeId(flow: FlowDefinition): string {
  let index = Object.keys(flow.edges).length + 1

  while (flow.edges[`edge-${index}`]) index += 1

  return `edge-${index}`
}
