import { shallowRef } from 'vue'
import type { Disposable } from '@lc/kernel'
import type { ProjectAssetCounts, ProjectDefinition, ProjectInput } from './project-model'
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  countProjectAssets,
  isProject,
  normalizeProjectInput,
} from './project-model'
import { createPersistentId } from '@lc/shared'
import { currentAssetLists } from './project-assets'

/**
 * 项目存储。
 *
 * 目前没有后端，存储落在 localStorage；接服务端时只需替换本文件的读写实现，
 * 与 `workflows/flow-store.ts`、`functions/global-functions.ts` 是同一种取舍。
 *
 * 本模块单向读取五类资产的存储来计算归属数量，资产侧只引用 `project-model`
 * 里的常量与纯函数，因此不存在循环依赖。
 */

const STORAGE_KEY = 'lc.projects.v1'
const listeners = new Set<() => void>()

/** 生成规则收敛到 @lc/shared；资产归属引用的就是它 */
function createProjectId(): string {
  return createPersistentId('project')
}

/**
 * 默认项目：存量资产的落点。
 *
 * 它不是一个「用户创建的项目」，而是一次改造的兼容层，所以不允许删除——
 * 删掉之后没有归属的资产就无处可去了。
 */
function createDefaultProject(): ProjectDefinition {
  const now = new Date().toISOString()

  return {
    id: DEFAULT_PROJECT_ID,
    name: DEFAULT_PROJECT_NAME,
    description: '改造前已存在的页面、流程、函数与组件都归在这里。',
    createdAt: now,
    updatedAt: now,
  }
}

function readStorage(): ProjectDefinition[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return [createDefaultProject()]

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [createDefaultProject()]

    // id 参与资产归属，重复条目会让同一个 projectId 指向两条项目
    const ids = new Set<string>()
    const entries = parsed.filter((item): item is ProjectDefinition => {
      if (!isProject(item)) return false
      if (ids.has(item.id)) return false
      ids.add(item.id)
      return true
    })

    // 手改存储删掉默认项目会让存量资产的归属悬空，读档时补回来
    if (!entries.some((item) => item.id === DEFAULT_PROJECT_ID)) {
      return [createDefaultProject(), ...entries]
    }

    return entries
  } catch (error) {
    console.error('[host] 读取项目存储失败，按仅含默认项目处理', error)
    return [createDefaultProject()]
  }
}

function persist(entries: readonly ProjectDefinition[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch (error) {
    // 隐私模式或配额不足时只丢持久化，当前会话里的项目仍然可编辑
    console.error('[host] 保存项目到 localStorage 失败', error)
  }
}

const state = shallowRef<readonly ProjectDefinition[]>(readStorage())

/** 项目列表；只读约定由调用方遵守，写入必须走本模块的 create / update / remove */
export const projects = state

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function commit(next: readonly ProjectDefinition[]): void {
  state.value = next
  persist(next)
  notify()
}

/**
 * 某个项目名下的资产数量。
 *
 * 卡片展示与删除拦截都读它，两处口径天然一致。
 */
export function countAssetsOf(projectId: string): ProjectAssetCounts {
  return countProjectAssets(currentAssetLists(), projectId)
}

/**
 * 新建一个项目。
 *
 * 建完直接入库并返回记录：调用方拿到 id 就把它当作后续资产的归属目标，
 * 不落库的话「新建项目」在刷新后等于没发生。
 *
 * @throws 名称为空时抛错，错误文案可直接展示给用户
 */
export function createProject(input: ProjectInput): ProjectDefinition {
  const { name, description } = normalizeProjectInput(input)
  if (name === '') throw new Error('[host] 项目必须命名')

  const now = new Date().toISOString()
  const created: ProjectDefinition = {
    id: createProjectId(),
    name,
    description,
    createdAt: now,
    updatedAt: now,
  }

  commit([...state.value, created])
  return created
}

/**
 * 修改项目的名称与说明。
 *
 * 名称之外的字段整体替换：`description` 传空白串就是清空，不做「不传即保持不变」，
 * 否则调用方要记住哪个字段是补丁、哪个是全量。
 *
 * @throws 名称为空或 id 不存在时抛错
 */
export function updateProject(id: string, input: ProjectInput): ProjectDefinition {
  const current = state.value.find((item) => item.id === id)
  if (!current) throw new Error(`[host] 项目不存在: ${id}`)

  const { name, description } = normalizeProjectInput(input)
  if (name === '') throw new Error('[host] 项目必须命名')

  const next: ProjectDefinition = {
    ...current,
    name,
    description,
    updatedAt: new Date().toISOString(),
  }

  commit(state.value.map((item) => (item.id === id ? next : item)))
  return next
}

/**
 * 移动项目的线上版本指针。
 *
 * `publishedRevision` 只有发布与回滚两个写入方，都在 `release-store.ts` 里，所以这里
 * 不校验这个号是否真有一份快照对应：快照表在另一边，在这里再判一次就是两套规则。
 * 调用方负责保证指向的内容存在。
 *
 * @throws id 不存在时抛错
 */
export function setPublishedRevision(id: string, revision: number): ProjectDefinition {
  const current = state.value.find((item) => item.id === id)
  if (!current) throw new Error(`[host] 项目不存在: ${id}`)

  const next: ProjectDefinition = {
    ...current,
    publishedRevision: revision,
    updatedAt: new Date().toISOString(),
  }

  commit(state.value.map((item) => (item.id === id ? next : item)))
  return next
}

/**
 * 删除一个项目。
 *
 * 两道拦截：默认项目承接没有归属的存量资产；名下一致还有资产的项目删掉会让这些
 * 资产变成孤儿（既不在这个项目也不在默认项目里）。两者都抛可直接展示的文案，
 * 而不是悄悄把资产挪走——静默搬家会让用户找不到自己删掉的东西。
 *
 * @throws 删除默认项目、或项目内仍有资产时抛错；id 不存在时不做任何事
 */
export function removeProject(id: string): void {
  if (!state.value.some((item) => item.id === id)) return

  if (id === DEFAULT_PROJECT_ID) {
    throw new Error('[host] 默认项目不能删除：它承接没有归属的存量资产')
  }

  const counts = countAssetsOf(id)
  const owned = counts.pages + counts.flows + counts.functions + counts.components + counts.apis
  if (owned > 0) {
    throw new Error(
      `[host] 项目内还有 ${owned} 项资产（页面 ${counts.pages} · 流程 ${counts.flows} · ` +
        `函数 ${counts.functions} · 组件 ${counts.components} · 接口 ${counts.apis}），先移走或删掉再删项目`,
    )
  }

  commit(state.value.filter((item) => item.id !== id))
}

/** 按 id 取项目 */
export function getProject(id: string): ProjectDefinition | undefined {
  return state.value.find((item) => item.id === id)
}

/** 订阅项目列表变更；返回注销句柄 */
export function onProjectsChange(listener: () => void): Disposable {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}
