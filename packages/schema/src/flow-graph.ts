/**
 * 流程图上的纯算法。
 *
 * 与 `flow.ts` 分开是因为职责不同：前者是「数据长什么样」，本文件是「在数据上算得出什么」，
 * 两边都不碰 DOM、不读宿主状态，因此环检测与可达性既能被发布校验用，也能被执行器用，
 * 不需要为了测试而搭运行时。
 */

import type { ActionFieldSchema } from './actions'
import { checkExpressionFields } from './validate'
import type { ValidationIssue } from './validate'
import type { FlowDefinition, FlowEdge, FlowNode } from './flow'
import {
  FLOW_BRANCH_FALSE,
  FLOW_BRANCH_TRUE,
  FLOW_BRANCH_TYPES,
  FLOW_SWITCH,
  flowNodeFields,
  isFlowTriggerNode,
  readFlowTriggerBinding,
} from './flow'

/** 节点 id → 出边列表；一次遍历建好，供走图与校验共用，避免每个节点重扫一遍全表 */
export type FlowAdjacency = ReadonlyMap<string, readonly FlowEdge[]>

/**
 * 建立出边邻接表。
 *
 * 只收录两端都存在的边：悬空边由 {@link validateFlow} 报 error，执行器不该因为一条
 * 坏边就抛异常——试运行时看到「哪条线没连上」比整个面板崩掉有用。
 * 边按 `id` 排序写入，同一份文档每次建立的邻接表一致，并行扇出的先后顺序才可复现。
 *
 * @param flow 待分析的流程图
 * @returns 源节点 id 到其出边数组的映射；无出边的节点不出现在表里
 */
export function buildFlowAdjacency(flow: FlowDefinition): FlowAdjacency {
  const grouped = new Map<string, FlowEdge[]>()

  for (const edge of Object.values(flow.edges)) {
    if (!flow.nodes[edge.source] || !flow.nodes[edge.target]) continue

    const list = grouped.get(edge.source)
    if (list) list.push(edge)
    else grouped.set(edge.source, [edge])
  }

  for (const list of grouped.values()) list.sort((a, b) => a.id.localeCompare(b.id))

  return grouped
}

/**
 * 按出边邻接表取一个节点的后继边。
 *
 * 与直接 `adjacency.get(id) ?? []` 的差别只在于把「无出边」这件事写成一次调用，
 * 让走图代码里不出现 `?? []` 这类形状判断。
 *
 * @param adjacency {@link buildFlowAdjacency} 的结果
 * @param nodeId 节点 id
 * @returns 该节点的出边；叶子节点为空数组
 */
export function flowOutEdges(adjacency: FlowAdjacency, nodeId: string): readonly FlowEdge[] {
  return adjacency.get(nodeId) ?? []
}

/**
 * 取图的触发节点。
 *
 * 一张图只应有一个触发节点，但这里返回数组而不是单个：校验需要把「多个触发」这件事
 * 报成一条能指出多余节点的问题，而执行器只取第一个——两者读的是同一份事实。
 *
 * @param flow 待分析的流程图
 * @returns 触发节点列表，按文档中的声明顺序
 */
export function findFlowTriggers(flow: FlowDefinition): FlowNode[] {
  return Object.values(flow.nodes).filter(isFlowTriggerNode)
}

/**
 * 从起点出发可达的节点 id 集合（含起点自身）。
 *
 * 沿所有出边推进，不区分分支标记：条件节点两条分支都算「可能执行到」，否则未走到的
 * 那一侧会被误报成孤立节点。
 *
 * @param flow 待分析的流程图
 * @param startId 起点节点 id；起点不存在时返回空集
 * @returns 可达节点 id 集合
 */
export function collectFlowReachable(
  flow: FlowDefinition,
  startId: string,
): ReadonlySet<string> {
  const reachable = new Set<string>()
  if (!flow.nodes[startId]) return reachable

  const adjacency = buildFlowAdjacency(flow)
  const queue = [startId]

  // 用游标而不是 shift：shift 每次移动整个数组，大图上遍历会退化成 O(n²)
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    if (reachable.has(current)) continue

    reachable.add(current)
    for (const edge of flowOutEdges(adjacency, current)) {
      if (!reachable.has(edge.target)) queue.push(edge.target)
    }
  }

  return reachable
}

/**
 * 找出图里的环。
 *
 * 一次执行中每个节点最多跑一次（见 `flow.ts` 的访问过即跳过约定），所以回边不会带来
 * 额外的执行次数，只会让后半张图永远到不了——与其在执行器里静默截断，不如在设计期
 * 指名道姓地报出来。
 *
 * 用三色 DFS，返回的每条环按「回到栈上节点的那条边」记录，环内节点顺序即遍历顺序。
 * 同一处环可能被不同起点各报一次，调用方只做展示，不去重。
 *
 * @param flow 待分析的流程图
 * @returns 环路径列表；无环时为空数组
 */
export function detectFlowCycles(flow: FlowDefinition): string[][] {
  const adjacency = buildFlowAdjacency(flow)
  const done = new Set<string>()
  const onStack = new Set<string>()
  const path: string[] = []
  const cycles: string[][] = []

  function visit(nodeId: string): void {
    if (done.has(nodeId)) return

    onStack.add(nodeId)
    path.push(nodeId)

    for (const edge of flowOutEdges(adjacency, nodeId)) {
      if (onStack.has(edge.target)) {
        const start = path.indexOf(edge.target)
        cycles.push(path.slice(start === -1 ? 0 : start).concat(edge.target))
        continue
      }

      visit(edge.target)
    }

    path.pop()
    onStack.delete(nodeId)
    done.add(nodeId)
  }

  for (const nodeId of Object.keys(flow.nodes)) visit(nodeId)

  return cycles
}

/** 必填字段的空值判定：未填、空串、空集合都算没填 */
function isEmptyFieldValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0

  return false
}

/** 逐字段检查必填项；表达式字段的形状单独走 `checkExpressionFields`，那里已有更准的文案 */
function checkRequiredFields(
  node: FlowNode,
  fields: readonly ActionFieldSchema[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const field of fields) {
    if (!field.required || field.kind === 'expression') continue
    if (!isEmptyFieldValue(node.config[field.key])) continue

    issues.push({
      path: `/nodes/${node.id}/config/${field.key}`,
      message: `${field.label}未填写`,
      severity: 'error',
    })
  }

  return issues
}

/**
 * 分支节点的出边标记检查。
 *
 * `flow.condition` 要求是 / 否两条边都在，且每条出边都要标明属于哪一侧：缺一条会让
 * 该分支直接结束整张图，而作者的本意几乎不可能是「什么都不做」——参考图的
 * 「否 → 直接通过」就是必填的一侧。
 *
 * `flow.switch` 只要求至少一条带标记的边：匹配值由业务决定，协议层无法枚举，
 * 强行按 true/false 要求会把合法的三分支配置报成错误。
 */
function checkBranchEdges(node: FlowNode, outEdges: readonly FlowEdge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const title = node.name ?? node.id

  if (!FLOW_BRANCH_TYPES.has(node.type)) {
    for (const edge of outEdges) {
      if (edge.branch) {
        issues.push({
          path: `/edges/${edge.id}/branch`,
          message: `「${title}」不是分支节点，其出边不应带分支标记`,
          severity: 'warning',
        })
      }
    }

    return issues
  }

  const branches = new Set(outEdges.map((edge) => edge.branch))

  if (node.type === FLOW_SWITCH) {
    if (branches.size === 0 || !outEdges.some((edge) => edge.branch)) {
      issues.push({
        path: `/nodes/${node.id}`,
        message: `多分支节点「${title}」的出边都没有匹配值，任何情况都不会往下走`,
        severity: 'error',
      })
    }

    return issues
  }

  if (!branches.has(FLOW_BRANCH_TRUE)) {
    issues.push({
      path: `/nodes/${node.id}`,
      message: `条件节点「${title}」缺少「是」分支连线`,
      severity: 'error',
    })
  }

  if (!branches.has(FLOW_BRANCH_FALSE)) {
    issues.push({
      path: `/nodes/${node.id}`,
      message: `条件节点「${title}」缺少「否」分支连线`,
      severity: 'error',
    })
  }

  for (const edge of outEdges) {
    if (edge.branch) continue

    issues.push({
      path: `/edges/${edge.id}/branch`,
      message: `「${title}」的出边必须标明是成立还是不成立`,
      severity: 'error',
    })
  }

  return issues
}

/**
 * 校验一张流程图能不能发布。
 *
 * 覆盖六类问题，都是「图上看不出来但执行会不对」的那种：
 *  1. 流程自身完整性（名称、键与 id 一致）；
 *  2. 触发节点唯一且绑定完整——没有它这张图永远不会被事件唤起；
 *  3. 连线两端存在、不自环、不重复；
 *  4. 无环（一次执行每节点至多一次，回边只会让后半张图不可达）；
 *  5. 分支节点的出边标记完整；
 *  6. 节点必填配置与表达式字段形状。
 *
 * 孤立节点报 warning 而不是 error：草稿阶段允许先摆几个节点再连线，发布时由调用方
 * 决定是否放行（见 `hasBlockingIssue`）。叶子节点不告警——走到尽头自然结束是正常形态，
 * `flow.end` 表达的是「提前终止」，不是每张图都必须有的收尾。
 *
 * @param flow 待校验的流程图
 * @returns 问题列表；无问题时为空数组
 */
export function validateFlow(flow: FlowDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const adjacency = buildFlowAdjacency(flow)
  const nodes = Object.entries(flow.nodes)

  if (flow.name.trim() === '') {
    issues.push({ path: '/name', message: '流程未命名', severity: 'error' })
  }

  for (const [key, node] of nodes) {
    if (node.id !== key) {
      issues.push({
        path: `/nodes/${key}/id`,
        message: `节点键 "${key}" 与节点 id "${node.id}" 不一致`,
        severity: 'error',
      })
    }
  }

  const triggers = findFlowTriggers(flow)
  if (triggers.length === 0) {
    issues.push({
      path: '/nodes',
      message: '流程缺少触发节点，任何事件都不会执行它',
      severity: 'error',
    })
  }
  if (triggers.length > 1) {
    for (const extra of triggers.slice(1)) {
      issues.push({
        path: `/nodes/${extra.id}`,
        message: '一张流程只允许一个触发节点，多余的触发请拆成独立流程',
        severity: 'error',
      })
    }
  }
  if (triggers.length === 1 && !readFlowTriggerBinding(triggers[0])) {
    issues.push({
      path: `/nodes/${triggers[0].id}/config`,
      message: '触发节点未填来源节点与事件名，事件匹配不上',
      severity: 'error',
    })
  }

  const seenLinks = new Set<string>()
  for (const edge of Object.values(flow.edges)) {
    if (!flow.nodes[edge.source]) {
      issues.push({
        path: `/edges/${edge.id}/source`,
        message: `连线的源节点 "${edge.source}" 不存在`,
        severity: 'error',
      })
    }

    if (!flow.nodes[edge.target]) {
      issues.push({
        path: `/edges/${edge.id}/target`,
        message: `连线的目标节点 "${edge.target}" 不存在`,
        severity: 'error',
      })
    }

    if (edge.source === edge.target) {
      issues.push({
        path: `/edges/${edge.id}`,
        message: '连线指向了自身所在节点',
        severity: 'error',
      })
    }

    const linkKey = `${edge.source}>${edge.target}[${edge.branch ?? ''}]`
    if (seenLinks.has(linkKey)) {
      issues.push({
        path: `/edges/${edge.id}`,
        message: '同一对节点之间存在完全相同的连线',
        severity: 'error',
      })
    }
    seenLinks.add(linkKey)
  }

  for (const cycle of detectFlowCycles(flow)) {
    issues.push({
      path: `/nodes/${cycle[0]}`,
      message: `节点之间存在环：${cycle.join(' → ')}`,
      severity: 'error',
    })
  }

  for (const [, node] of nodes) {
    const outEdges = flowOutEdges(adjacency, node.id)
    const fields = flowNodeFields(node.type)

    issues.push(...checkRequiredFields(node, fields))
    issues.push(...checkExpressionFields(node, fields, `/nodes/${node.id}`))
    issues.push(...checkBranchEdges(node, outEdges))

    if (node.onError === 'fallback') {
      const fallbackId = node.fallbackActionId
      if (!fallbackId) {
        issues.push({
          path: `/nodes/${node.id}/fallbackActionId`,
          message: `「${node.name ?? node.id}」的失败策略为补救，但未指定补救节点`,
          severity: 'error',
        })
      } else if (!flow.nodes[fallbackId]) {
        issues.push({
          path: `/nodes/${node.id}/fallbackActionId`,
          message: `补救节点 "${fallbackId}" 不存在`,
          severity: 'error',
        })
      }
    }
  }

  const start = triggers[0]
  if (start) {
    const reachable = collectFlowReachable(flow, start.id)

    for (const [key, node] of nodes) {
      if (isFlowTriggerNode(node) || reachable.has(node.id)) continue

      issues.push({
        path: `/nodes/${key}`,
        message: `「${node.name ?? key}」从触发节点不可达，永远不会执行`,
        severity: 'warning',
      })
    }
  }

  return issues
}
