import type { LayoutConstraints, NodeSchema, Rect } from '@lc/schema'

/**
 * 约束重排：把「设计时的节点图」按容器实际尺寸重新解析一遍。
 *
 * 语义与 Figma 的 Constraints 一致，直接复用 schema 里早已声明但没人接的
 * `LayoutConstraints`：容器尺寸变化时，子节点按锚点移动、按声明拉伸，而不是整张图
 * 元图等比缩放（那是另一件事：Scale 操作会连字号与描边一起改，Figma 把它做成独立工具
 * 并且明确忽略约束）。
 *
 * 参考系是父节点：蓝图节点存的是世界矩形，这里先换算成「相对父容器左/上角」的局部量
 * 再求解，因此嵌套容器逐层收缩时不会互相拉扯。
 */

/** 水平约束候选；属性面板的下拉共用这份清单，避免两处字面量各写一遍 */
export type HorizontalConstraint = NonNullable<LayoutConstraints['horizontal']>

/** 垂直约束候选 */
export type VerticalConstraint = NonNullable<LayoutConstraints['vertical']>

/** 水平约束候选清单；与 `HorizontalConstraint` 同向，属性面板下拉共用 */
export const HORIZONTAL_CONSTRAINTS: readonly HorizontalConstraint[] = [
  'left',
  'right',
  'center',
  'scale',
  'stretch',
]

/** 垂直约束候选 */
export const VERTICAL_CONSTRAINTS: readonly VerticalConstraint[] = [
  'top',
  'bottom',
  'center',
  'scale',
  'stretch',
]

/** 单轴上的解析结果 */
interface Axis {
  /** 相对父容器左/上角的偏移（px） */
  offset: number
  /** 自身尺寸（px） */
  size: number
}

/** 单轴约束解析模式；由 `modeOf` 从约束字面量映射，未知取值回落 start */
type AxisMode = 'start' | 'end' | 'center' | 'scale' | 'stretch'

/**
 * 约束字面量 → 单轴模式。
 *
 * 起点/终点值随轴不同（left 与 top），因此由调用方传入；缺省与未知取值都按 start 处理，
 * 与 Figma 的默认一致：「没配约束」意味着尺寸不变、相对父容器起点的位置也不变。
 */
function modeOf(value: string | undefined, start: string, end: string): AxisMode {
  switch (value) {
    case undefined:
      return 'start'
    case start:
      return 'start'
    case end:
      return 'end'
    case 'center':
      return 'center'
    case 'scale':
      return 'scale'
    case 'stretch':
      return 'stretch'
    default:
      return 'start'
  }
}

/**
 * 单轴求解。统一用「容器增减量」表达，五种模式都只剩几行算术：
 * - start / end：位置跟着容器边界走，尺寸不变
 * - center：增减量对半分，尺寸不变
 * - scale：位置与尺寸同比例变化，会改变元素大小
 * - stretch：两端间距固定，尺寸吃掉全部增减量
 */
function resolveAxis(
  local: number,
  size: number,
  designSpan: number,
  actualSpan: number,
  mode: AxisMode,
): Axis {
  const delta = actualSpan - designSpan

  switch (mode) {
    case 'start':
      return { offset: local, size }
    case 'end':
      return { offset: local + delta, size }
    case 'center':
      return { offset: local + delta / 2, size }
    case 'scale': {
      // 容器还没测到尺寸（宽或高为 0）时按原样渲染：让整棵子树塌成一条线，
      // 比"缩到 0"更像故障而不是设计，首帧与隐藏容器都会踩到
      const ratio = designSpan > 0 && actualSpan > 0 ? actualSpan / designSpan : 1
      return { offset: local * ratio, size: size * ratio }
    }
    case 'stretch':
      return { offset: local, size: Math.max(0, size + delta) }
  }
}

/**
 * 解析单个节点在容器变化后的绝对矩形。
 *
 * @param node 待解析节点，读它的 `layout.rect` 与 `layout.constraints`
 * @param designParent 父节点设计时的矩形，局部偏移以它为基准
 * @param actualParent 父节点解析后的矩形，即当前可用空间
 */
export function resolveRect(node: NodeSchema, designParent: Rect, actualParent: Rect): Rect {
  const rect = node.layout?.rect ?? { x: 0, y: 0, width: 0, height: 0 }
  const constraints = node.layout?.constraints

  const horizontal = resolveAxis(
    rect.x - designParent.x,
    rect.width,
    designParent.width,
    actualParent.width,
    modeOf(constraints?.horizontal, 'left', 'right'),
  )
  const vertical = resolveAxis(
    rect.y - designParent.y,
    rect.height,
    designParent.height,
    actualParent.height,
    modeOf(constraints?.vertical, 'top', 'bottom'),
  )

  return {
    x: actualParent.x + horizontal.offset,
    y: actualParent.y + vertical.offset,
    width: horizontal.size,
    height: vertical.size,
  }
}

/** 树形输入的最小结构；`RenderNode` 天然满足，这里不依赖渲染层类型 */
export interface LayoutNode {
  /** 渲染 key，作为结果 Map 的键 */
  key: string
  /** 原始 schema 节点 */
  node: NodeSchema
  /** 设计时的世界矩形 */
  rect: Rect
  /** 子节点 */
  children: readonly LayoutNode[]
}

/**
 * 自顶向下解析整棵节点图，返回 `key → 实际矩形`。
 *
 * 顶层里 key 等于 `rootKey` 的那个节点就是这个组件本身：它直接吃满目标容器，
 * 不参与约束计算——「拖边框改的是组件大小」首先得让根容器真的跟着变大，
 * 其余节点再以「设计根矩形 → 实际根矩形」为基准逐层重排。
 */
export function resolveRects(
  items: readonly LayoutNode[],
  designParent: Rect,
  actualParent: Rect,
  rootKey: string,
): Map<string, Rect> {
  const result = new Map<string, Rect>()

  const walk = (
    list: readonly LayoutNode[],
    parentDesign: Rect,
    parentActual: Rect,
    isTopLevel: boolean,
  ): void => {
    for (const item of list) {
      const rect =
        isTopLevel && item.key === rootKey
          ? parentActual
          : resolveRect(item.node, parentDesign, parentActual)
      result.set(item.key, rect)
      walk(item.children, item.rect, rect, false)
    }
  }

  walk(items, designParent, actualParent, true)
  return result
}
