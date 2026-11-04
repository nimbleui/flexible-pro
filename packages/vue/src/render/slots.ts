import type { NodeSchema, SlotDefinition } from '@lc/schema'
import type { RenderNode } from './tree'

/**
 * 插槽内容分组。
 *
 * 放在渲染层而不是组件里，是为了让画布（设计态）与运行时预览用同一份口径判定
 * 「哪些内容归组件、哪些仍按兄弟节点平铺」，两处各写一遍迟早会漂移。
 */

/** 蓝图里标记内容接收区的物料名；由宿主物料包提供实现 */
export const SLOT_OUTLET = 'SlotOutlet'

/** 一次分组结果 */
export interface SlotSplit {
  /** 交给组件的具名内容；只包含真的有内容的插槽 */
  named: Record<string, RenderNode[]>
  /** 仍由外层平铺渲染的子节点（`children` 与未声明插槽） */
  rest: RenderNode[]
}

/**
 * 按物料声明的插槽把渲染子节点分组。
 *
 * 只有「声明过的具名插槽」里的节点才交给组件：`canvas-drop` 只会往声明的格子里写，
 * 但历史文档与手改的 localStorage 都可能留下没声明的插槽名，那些内容继续平铺渲染，
 * 而不是因为组件没声明就被静默吞掉。
 *
 * 没有声明时整棵子树回到 `rest`，行为与引入插槽分发之前完全一致。
 *
 * @param node 承载内容的节点（读它的 `slots` 引用表）
 * @param children 该节点已构建好的渲染子节点
 * @param declared 物料声明的插槽；`undefined` 或空数组表示不声明
 */
export function splitSlotChildren(
  node: NodeSchema,
  children: readonly RenderNode[],
  declared: readonly SlotDefinition[] | undefined,
): SlotSplit {
  if (!declared?.length) return { named: {}, rest: [...children] }

  // 归属按节点 id 反查插槽名：一个 id 落进多个插槽时以先声明的为准，
  // 这种数据本身就是错的，但至少不会渲染出两份
  const ownerOf = new Map<string, string>()
  for (const slot of declared) {
    for (const id of node.slots?.[slot.name] ?? []) {
      if (!ownerOf.has(id)) ownerOf.set(id, slot.name)
    }
  }

  const named: Record<string, RenderNode[]> = {}
  const rest: RenderNode[] = []

  for (const child of children) {
    const slot = ownerOf.get(child.node.id)
    if (slot === undefined) {
      rest.push(child)
      continue
    }
    const group = named[slot]
    if (group) group.push(child)
    else named[slot] = [child]
  }

  return { named, rest }
}

/**
 * 收集蓝图里声明的插槽出口名。
 *
 * 出口是组件作者写的「内容接收区」：有出口时只渲染这些插槽的内容，
 * 一个出口都没有时返回空数组，由调用方决定退回「全部内容都渲染」。
 *
 * 出口的 `name` 只认字符串字面量：写成表达式时这里读不到值，按未声明处理，
 * 比拿一个不确定的插槽名去匹配内容更安全。
 */
export function outletSlotNames(
  nodes: Readonly<Record<string, NodeSchema>>,
): readonly string[] {
  const names: string[] = []

  for (const node of Object.values(nodes)) {
    if (node.componentName !== SLOT_OUTLET) continue

    const raw: unknown = node.props?.name
    if (typeof raw !== 'string' || raw === '') continue
    if (!names.includes(raw)) names.push(raw)
  }

  return names
}

/**
 * 决定实例内容里哪些插槽要交给组件渲染。
 *
 * 组件声明过出口就按出口过滤，一个都没声明就全给——把「忘记放出口」与「故意不显示
 * 某个插槽」区分开，前者不该让内容凭空消失。走 `children` 的内容不在这里出现，
 * 它由调用方作为兄弟节点渲染，因此不需要给 `default` 开后门。
 *
 * @param outlets 蓝图里的出口名
 * @param content 实例实际有内容的插槽名
 * @returns 要渲染的插槽名，顺序沿用 `content`
 */
export function renderableSlots(
  outlets: readonly string[],
  content: readonly string[],
): readonly string[] {
  if (outlets.length === 0) return content
  return content.filter((name) => outlets.includes(name))
}
