import type { SnapCandidate, SnapContext } from '@lc/contracts'
import { rectIntersects } from '@lc/canvas'
import type { NodeSchema } from '@lc/schema'

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
    for (const edge of [rect.x, rect.x + rect.width]) {
      pushNearEdge('x', gridBelow(edge, step), edge)
      pushNearEdge('x', gridAbove(edge, step), edge)
    }
    for (const edge of [rect.y, rect.y + rect.height]) {
      pushNearEdge('y', gridBelow(edge, step), edge)
      pushNearEdge('y', gridAbove(edge, step), edge)
    }
  }

  return candidates
}

/**
 * 节点吸附候选：视口内其他节点的左/中/右、上/中/下。
 *
 * `movingIds` 里的节点被排除，避免拖拽节点吸附到自己。
 * `priority: 1` 使其位于网格层之上：对象对齐是用户看到的辅助线，优先级不该输给
 * 由自身几何推导出来的网格候选。
 */
export function elementCandidates(
  context: SnapContext,
  nodes: Record<string, NodeSchema>,
): SnapCandidate[] {
  // movingIds 缺省时不排除任何节点，会把被拖元素自己也当成候选；调用方必须传
  const excluded = new Set(context.movingIds ?? [])
  const candidates: SnapCandidate[] = []

  for (const node of Object.values(nodes)) {
    if (excluded.has(node.id)) continue

    const rect = node.layout?.rect
    if (!rect) continue
    if (!rectIntersects(rect, context.viewportRect)) continue

    for (const value of [rect.x, rect.x + rect.width / 2, rect.x + rect.width]) {
      candidates.push({ axis: 'x', value, source: `node:${node.id}`, priority: 1 })
    }
    for (const value of [rect.y, rect.y + rect.height / 2, rect.y + rect.height]) {
      candidates.push({ axis: 'y', value, source: `node:${node.id}`, priority: 1 })
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
