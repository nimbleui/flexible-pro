import type { Rect } from '@lc/schema'

/**
 * 对齐方式。
 *
 * 前三项沿 x 轴摆位、后三项沿 y 轴摆位，基准始终是选中集包围盒的对应边或中线，
 * 而不是画布或文档根。
 */
export type AlignMode = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'

/** 参与对齐/分布的节点快照 */
export interface AlignNode {
  /** 节点 id，用于回写 patch 路径 */
  id: string
  /** 世界矩形；对齐只改 x/y，宽高保持入参值 */
  rect: Rect
}

/** 多个矩形的联合包围盒；空集合返回 undefined。 */
export function boundsOf(nodes: readonly AlignNode[]): Rect | undefined {
  if (nodes.length === 0) return undefined

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const { rect } of nodes) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * 六向对齐：以选中集包围盒为基准，尺寸不变、只移动位置。
 *
 * 单选时包围盒等于自身，命令无实际效果；调用方应通过 `enabled`
 * 要求至少两个节点，避免用户误触后没有任何反馈。
 */
export function alignRects(nodes: readonly AlignNode[], mode: AlignMode): AlignNode[] {
  const bounds = boundsOf(nodes)
  if (!bounds) return []

  return nodes.map(({ id, rect }) => {
    switch (mode) {
      case 'left':
        return { id, rect: { ...rect, x: bounds.x } }
      case 'centerX':
        return { id, rect: { ...rect, x: bounds.x + (bounds.width - rect.width) / 2 } }
      case 'right':
        return { id, rect: { ...rect, x: bounds.x + bounds.width - rect.width } }
      case 'top':
        return { id, rect: { ...rect, y: bounds.y } }
      case 'centerY':
        return { id, rect: { ...rect, y: bounds.y + (bounds.height - rect.height) / 2 } }
      case 'bottom':
        return { id, rect: { ...rect, y: bounds.y + bounds.height - rect.height } }
      default:
        return { id, rect }
    }
  })
}

/**
 * 等间距分布（First/Last 固定）。
 *
 * 沿轴按中心排序后，首尾节点保持不动，中间节点按「边到边等间距」重排：
 * `gap = (末边 - 首边 - 总宽) / (n - 1)`。宽度之和超过跨度时 gap 为负，
 * 节点会重叠——这与主流设计工具一致，不做强行撑开。
 *
 * 少于 3 个节点时返回每项的新副本（位置不变），调用方不必区分是否发生了重排。
 * 排序只用于计算落位，返回值顺序始终与入参一致；中心点相同则按入参下标决定先后。
 */
export function distributeRects(nodes: readonly AlignNode[], axis: 'x' | 'y'): AlignNode[] {
  if (nodes.length < 3) return nodes.map((node) => ({ ...node, rect: { ...node.rect } }))

  const sorted = nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const centerA =
        axis === 'x'
          ? a.node.rect.x + a.node.rect.width / 2
          : a.node.rect.y + a.node.rect.height / 2
      const centerB =
        axis === 'x'
          ? b.node.rect.x + b.node.rect.width / 2
          : b.node.rect.y + b.node.rect.height / 2
      if (centerA !== centerB) return centerA - centerB
      return a.index - b.index
    })
    .map((entry) => entry.node)

  const first = sorted[0] as AlignNode
  const last = sorted[sorted.length - 1] as AlignNode
  const spanStart = axis === 'x' ? first.rect.x : first.rect.y
  const spanEnd = axis === 'x' ? last.rect.x + last.rect.width : last.rect.y + last.rect.height
  const totalSize = sorted.reduce(
    (sum, node) => sum + (axis === 'x' ? node.rect.width : node.rect.height),
    0,
  )
  const gap = (spanEnd - spanStart - totalSize) / (sorted.length - 1)

  const nextById = new Map<string, Rect>()
  let cursor = spanStart
  for (const node of sorted) {
    const size = axis === 'x' ? node.rect.width : node.rect.height
    const rect = axis === 'x' ? { ...node.rect, x: cursor } : { ...node.rect, y: cursor }
    nextById.set(node.id, rect)
    cursor += size + gap
  }

  return nodes.map((node) => ({ id: node.id, rect: nextById.get(node.id) ?? node.rect }))
}
