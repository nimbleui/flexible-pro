import type { SnapCandidate, SnapContext } from '@lc/contracts'
import { rectIntersects } from '@lc/canvas'
import type { Rect } from '@lc/schema'

/** 判定「边已经在网格线上」的容差：这种候选等于让元素吸附到自己当前的位置 */
const SELF_EPSILON = 1e-6

/**
 * 网格吸附候选。
 *
 * 只为「正在移动矩形」的边生成最近两条网格线，且限制在世界阈值内，
 * 避免在 8px 网格上为整个视口生成上千个候选。
 *
 * 网格线本身按构造贴着被拖元素的边，因此两类情况要排除：
 * 已经落在网格线上的边不再产生候选（吸附自己、位移为 0），
 * 其余候选标记 `showGuide: false`，只吸附不画线，辅助线留给真实的外部对象。
 */
export function gridCandidates(context: SnapContext, step: number): SnapCandidate[] {
  if (step <= 0) return []

  const candidates: SnapCandidate[] = []
  const seen = new Set<string>()

  const pushNearEdge = (axis: 'x' | 'y', value: number, edge: number): void => {
    const distance = Math.abs(value - edge)
    if (distance <= SELF_EPSILON || distance > context.thresholdWorld) return

    // 多条边可以落在同一条网格线上，用 key 去重避免同一候选重复入列
    const key = `${axis}:${value}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ axis, value, source: 'grid', showGuide: false })
  }

  for (const rect of context.moving) {
    // 缩放只拖动一条边时不要为固定锚点生成候选：锚点本来就不动，候选只会
    // 在窄节点上与移动边争位
    const xMode = context.edges?.x ?? 'both'
    const yMode = context.edges?.y ?? 'both'

    for (const edge of [rect.x, rect.x + rect.width]) {
      if (edge === rect.x && xMode === 'end') continue
      if (edge !== rect.x && xMode === 'start') continue
      pushNearEdge('x', gridBelow(edge, step), edge)
      pushNearEdge('x', gridAbove(edge, step), edge)
    }
    for (const edge of [rect.y, rect.y + rect.height]) {
      if (edge === rect.y && yMode === 'end') continue
      if (edge !== rect.y && yMode === 'start') continue
      pushNearEdge('y', gridBelow(edge, step), edge)
      pushNearEdge('y', gridAbove(edge, step), edge)
    }
  }

  return candidates
}

/**
 * 元素吸附候选：视口内其他元素（由调用方给出）的左/中/右、上/中/下。
 *
 * 入参是「本画布实际渲染的元素几何」而不是文档节点表：渲染几何不依赖节点表结构；
 * 隐藏子树不登记几何，因此也不会被吸到。
 *
 * `movingIds` 里的元素被排除，避免拖拽元素吸附到自己。
 * `priority: 1` 使其位于网格层之上：对象对齐是用户看到的辅助线，优先级不该输给
 * 由自身几何推导出来的网格候选。
 *
 * @param elements 各节点的 id 与世界矩形；id 仅用于与 movingIds 比对排除自身，不进入候选结果；
 * rect 是节点当前世界矩形（含拖拽中的实时位移，不是 schema 静态值）
 */
export function elementCandidates(
  context: SnapContext,
  elements: readonly { id: string; rect: Rect }[],
): SnapCandidate[] {
  // movingIds 缺省时不排除任何元素，会把被拖元素自己也当成候选；调用方必须传
  const excluded = new Set(context.movingIds ?? [])
  const candidates: SnapCandidate[] = []

  for (const element of elements) {
    if (excluded.has(element.id)) continue

    const rect = element.rect
    if (!rectIntersects(rect, context.viewportRect)) continue

    for (const value of [rect.x, rect.x + rect.width / 2, rect.x + rect.width]) {
      candidates.push({ axis: 'x', value, source: `node:${element.id}`, priority: 1 })
    }
    for (const value of [rect.y, rect.y + rect.height / 2, rect.y + rect.height]) {
      candidates.push({ axis: 'y', value, source: `node:${element.id}`, priority: 1 })
    }
  }

  return candidates
}

/** 不大于 value 的最近网格线；floor 按数值取「下方」，负坐标同样成立 */
function gridBelow(value: number, step: number): number {
  return Math.floor(value / step) * step
}

/** 不小于 value 的最近网格线；与 gridBelow 一起覆盖边的两侧，取较近者 */
function gridAbove(value: number, step: number): number {
  return Math.ceil(value / step) * step
}
