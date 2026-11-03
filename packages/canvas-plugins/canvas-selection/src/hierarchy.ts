import type { NodeFlagView, Point } from '@lc/contracts'
import type { Rect } from '@lc/schema'
import type { PageSchema } from '@lc/schema'
import { findPosition } from '@lc/schema'

/** 选层用到的命中查询；只依赖 inRect，便于单测用最小替身 */
export interface StackHitTest {
  /** 返回与矩形相交的节点 id，按登记顺序（底 → 顶） */
  inRect(rect: Rect): readonly string[]
}

/**
 * 取节点的父级，并跳过隐藏 / 锁定的祖先。
 *
 * 向上选择（Esc / 双击）只能落到画布上能选中的层级：隐藏祖先没有几何，
 * 锁定祖先点不到，停在它们身上会让「选中」变成看不见、拖不动的状态。
 * 没有可用的父级时返回 undefined，调用方保持原选中集不变。
 */
export function selectableParent(
  schema: PageSchema,
  nodeId: string,
  flags: NodeFlagView,
): string | undefined {
  let parent = findPosition(schema, nodeId)?.parentId
  while (parent && (flags.hidden.has(parent) || flags.locked.has(parent))) {
    parent = findPosition(schema, parent)?.parentId
  }
  return parent
}

/**
 * 屏幕点上所有可选中节点的层叠列表，自上而下。
 *
 * 用 1×1 的屏幕矩形查命中，和点选共用同一套 AABB 与锁定过滤；场景登记顺序
 * 是底 → 顶，反转后第一项就是普通点击会选中的那个。
 *
 * @param screen 查询点的屏幕坐标（CSS 像素，相对舞台原点）；命中盒取 1×1，与点选同口径
 */
export function stackAt(hitTest: StackHitTest, screen: Point): string[] {
  const near: Rect = { x: screen.x, y: screen.y, width: 1, height: 1 }
  return [...hitTest.inRect(near)].reverse()
}

/**
 * 循环里取下一个候选。
 *
 * 当前节点不在列表里（换了个位置、或还没选过）时从最上层开始；
 * 已在列表里就取它的下一项，走到末尾回到开头。
 */
export function nextInCycle(
  stack: readonly string[],
  current: string | undefined,
): string | undefined {
  if (stack.length === 0) return undefined
  if (!current) return stack[0]
  const index = stack.indexOf(current)
  if (index < 0) return stack[0]
  return stack[(index + 1) % stack.length]
}

/** 直穿到底：层叠列表的最底层（普通点选命中的是最上层） */
export function outermostOf(stack: readonly string[]): string | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined
}
