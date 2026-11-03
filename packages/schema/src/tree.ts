/**
 * 节点树操作
 * ---
 * 图层树与层级 / 组合命令共享的一组纯函数：读取节点树、将结构变更算成 patch，
 * 由文档服务统一应用。这里不碰 DOM、不依赖画布，所以既能被面板（EditorRealm）
 * 使用，也能被画布命令（CanvasRealm）使用，而不需要两个 Realm 互相引用。
 */

import type { NodeSchema } from './node'
import type { PageSchema } from './page'
import type { SchemaPatch } from './patch'
import type { Rect } from './styles'
import { nodePath } from './patch'

/** 节点在其父级数组中的位置 */
export interface NodePosition {
  /** 父节点 id */
  parentId: string
  /** 所在具名插槽；省略表示 `children` 数组 */
  slot?: string
  /** 在该数组中的下标 */
  index: number
}

/** 图层树条目 */
export interface OutlineItem {
  /** 对应的 schema 节点；面板直接读它的显示名、显隐与锁定状态 */
  node: NodeSchema
  /** 子条目：children 在前、具名插槽按插槽键顺序在后 */
  children: OutlineItem[]
  /** 父级中的位置；文档根节点与游离节点为 undefined */
  position?: NodePosition
}

/** 层级调整方式 */
export type OrderMode = 'front' | 'forward' | 'backward' | 'back'

/** 设计态开关；写成 false 而不是删除字段，便于图层树直接反映状态 */
export interface NodeFlagChange {
  /** 目标显隐状态；省略表示本次不改写该开关，与 `false`（显式显示）不同 */
  hidden?: boolean
  /** 目标锁定状态；省略语义同 hidden */
  locked?: boolean
}

/** 组合结果 */
export interface GroupResult {
  /**
   * 需要按数组顺序依次应用的 patch：摘除成员引用 → 新增组节点 → 把组挂回锚点。
   *
   * 后写的同路径 patch 覆盖先写的，因此调用方不能自行重排或并行下发。
   */
  patches: SchemaPatch[]
  /** 新组节点 id，调用方据此选中新组 */
  groupId: string
}

/**
 * 节点的全部子引用：`children` 在前，随后是各具名插槽的节点。
 *
 * 顺序即渲染顺序，删除 / 复制 / 遍历都按这个顺序处理，两处语义不会分叉。
 */
export function childRefs(node: NodeSchema): string[] {
  const slots = Object.values(node.slots ?? {}).flat()
  return [...(node.children ?? []), ...slots]
}

function childArray(node: NodeSchema, slot: string | undefined): string[] {
  if (slot === undefined) return node.children ?? []
  return node.slots?.[slot] ?? []
}

function childPath(parentId: string, slot: string | undefined): string {
  return slot === undefined
    ? `${nodePath(parentId)}/children`
    : `${nodePath(parentId)}/slots/${slot}`
}

/**
 * 在全图里收集一组 id 的引用位置。
 *
 * 一次遍历返回所有命中，图层面板拖拽与解组都要用它，避免各写一遍父级扫描。
 * 同一个 id 被多个父级引用（脏数据）时全部返回，调用方按顺序处理。
 */
function collectPositions(schema: PageSchema, ids: ReadonlySet<string>): NodePosition[] {
  const found: NodePosition[] = []
  for (const [parentId, node] of Object.entries(schema.nodes)) {
    const index = node.children?.findIndex((childId) => ids.has(childId)) ?? -1
    if (index >= 0) found.push({ parentId, index })
    for (const [slot, children] of Object.entries(node.slots ?? {})) {
      const position = children.findIndex((childId) => ids.has(childId))
      if (position >= 0) found.push({ parentId, slot, index: position })
    }
  }
  return found
}

/** 节点在父级数组中的第一个位置；根节点与未被任何父级引用的节点返回 undefined */
export function findPosition(schema: PageSchema, nodeId: string): NodePosition | undefined {
  return collectPositions(schema, new Set([nodeId]))[0]
}

/**
 * 一组根节点及其全部后代。
 *
 * 环引用与重复引用只计一次；不存在的 id 直接跳过，坏文档不会让遍历转不完。
 */
export function collectSubtree(schema: PageSchema, roots: readonly string[]): Set<string> {
  const collected = new Set<string>()
  const stack = [...roots]

  while (stack.length > 0) {
    const id = stack.pop() as string
    if (collected.has(id)) continue
    const node = schema.nodes[id]
    if (!node) continue
    collected.add(id)
    stack.push(...childRefs(node))
  }

  return collected
}

/**
 * 从各自的父级数组中移除一批节点，返回替换父级引用数组的 patch。
 *
 * 只动引用、不动节点表：调用方若要连节点一起删，另外补 remove patch。
 * 集合内的节点自身不产生 patch——它要么整体被删（引用随之消失），要么正是
 * 被组合 / 被解散的那个组，其 children 数组由调用方另行处理。
 * 未被引用的节点自然不产生 patch。
 */
export function detachFromParents(schema: PageSchema, ids: ReadonlySet<string>): SchemaPatch[] {
  const patches: SchemaPatch[] = []
  for (const [parentId, node] of Object.entries(schema.nodes)) {
    if (ids.has(parentId)) continue
    if (node.children?.some((childId) => ids.has(childId))) {
      patches.push({
        op: 'replace',
        path: childPath(parentId, undefined),
        value: node.children.filter((childId) => !ids.has(childId)),
      })
    }
    for (const [slot, children] of Object.entries(node.slots ?? {})) {
      if (!children.some((childId) => ids.has(childId))) continue
      patches.push({
        op: 'replace',
        path: childPath(parentId, slot),
        value: children.filter((childId) => !ids.has(childId)),
      })
    }
  }
  return patches
}

/**
 * 构建图层树。
 *
 * 从文档根节点向下遍历，环引用与重复引用只保留第一次出现；遍历不到的节点
 * （父级被删但仍留在节点表里）作为顶层条目附在末尾，与渲染器的游离节点兜底一致，
 * 否则这类节点在图层树里彻底消失、无法被清理。
 */
export function buildOutlineTree(schema: PageSchema): OutlineItem[] {
  const visited = new Set<string>()

  const build = (nodeId: string, position?: NodePosition): OutlineItem | undefined => {
    if (visited.has(nodeId)) return undefined
    const node = schema.nodes[nodeId]
    if (!node) return undefined
    visited.add(nodeId)

    const children: OutlineItem[] = []
    node.children?.forEach((childId, index) => {
      const item = build(childId, { parentId: nodeId, index })
      if (item) children.push(item)
    })
    for (const [slot, ids] of Object.entries(node.slots ?? {})) {
      ids.forEach((childId, index) => {
        const item = build(childId, { parentId: nodeId, slot, index })
        if (item) children.push(item)
      })
    }

    return { node, children, position }
  }

  const roots: OutlineItem[] = []
  const root = build(schema.nodeId)
  if (root) roots.push(root)
  for (const nodeId of Object.keys(schema.nodes)) {
    const item = build(nodeId)
    if (item) roots.push(item)
  }
  return roots
}

/**
 * 图层树按关键词裁剪：只留下命中的节点，以及通往它们的祖先路径。
 *
 * 命中判定同时看显示名与组件名，因为大量节点没有改名，只搜 `name` 会搜不到。
 * 命中的容器不会自动带出整棵子树——否则搜「区域」会把画布塞满，
 * 面板要的是「这几处匹配在哪」，父级出现只是为了保住缩进能读出层级。
 * 关键词为空（含只有空白）时原样返回，调用方因此不需要为「没在搜」写分支。
 *
 * @param items `buildOutlineTree` 的结果
 * @param keyword 用户输入的关键词；大小写不敏感
 * @returns 新的条目数组；条目对象是重建的，但 `node` 仍引用 schema 里的原对象
 */
export function filterOutlineTree(
  items: readonly OutlineItem[],
  keyword: string,
): OutlineItem[] {
  const needle = keyword.trim().toLowerCase()
  if (needle.length === 0) return [...items]

  const kept: OutlineItem[] = []
  for (const item of items) {
    const children = filterOutlineTree(item.children, needle)
    const selfHit = `${item.node.name ?? ''} ${item.node.componentName}`
      .toLowerCase()
      .includes(needle)
    if (selfHit || children.length > 0) {
      kept.push({ node: item.node, children, position: item.position })
    }
  }
  return kept
}

/**
 * 绘制顺序的节点 id 序列（父在前、子在后），命中测试与 DOM 层叠共用这一套结论。
 *
 * 隐藏子树整体跳过：隐藏节点既不渲染也不该被点中，留在场景里会出现
 * 「看不见却能选中」的节点。
 */
export function paintOrder(schema: PageSchema): string[] {
  const ids: string[] = []
  const walk = (item: OutlineItem): void => {
    if (item.node.hidden === true) return
    ids.push(item.node.id)
    for (const child of item.children) walk(child)
  }
  for (const item of buildOutlineTree(schema)) walk(item)
  return ids
}

/** 数组内搬运一个元素：`from` 是先取出的下标，`to` 是取出后的插入下标 */
function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved !== undefined) next.splice(clamp(to, 0, next.length), 0, moved)
  return next
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 同一父级内重排子节点。
 *
 * 下标按「先移除再插入」解释：调用方拿到的 `to` 是去掉被拖条目之后数组里的位置，
 * 这样跨越边界时（从上往下拖）不必让调用方自己减一。
 * 父级或下标不合法时返回空 patch，不做任何写入。
 *
 * @param options.parentId 目标父节点 id；不存在时不产生 patch
 * @param options.slot 具名插槽；省略表示 `children` 数组
 * @param options.from 被拖条目在原数组中的下标
 * @param options.to 取出被拖条目之后，它在剩余数组里的目标下标
 */
export function reorderChildren(
  schema: PageSchema,
  options: { parentId: string; slot?: string; from: number; to: number },
): SchemaPatch[] {
  const { parentId, slot, from, to } = options
  if (from === to) return []
  const node = schema.nodes[parentId]
  if (!node) return []

  const current = childArray(node, slot)
  const moved = current[from]
  if (moved === undefined || current[to] === undefined) return []

  return [
    { op: 'replace', path: childPath(parentId, slot), value: moveItem(current, from, to) },
  ]
}

/**
 * 批量调整层叠顺序。
 *
 * 「上移 / 置顶」= 在数组里往后靠：渲染按数组顺序生成 DOM，后出现的兄弟节点盖在
 * 前面的之上。同一次调用里，同一父级下的所有选中节点一起算，避免逐节点各算一遍
 * 数组、后写的 patch 把先写的覆盖掉。
 * 相邻两个选中节点互换位置没有意义，所以「上移一层」只与未选中的兄弟交换。
 * 结果与输入一致（已在边界）时不产生 patch，命令因此不会写下空历史。
 */
export function changeOrders(
  schema: PageSchema,
  ids: readonly string[],
  mode: OrderMode,
): SchemaPatch[] {
  const selected = new Set(ids.filter((id) => schema.nodes[id] !== undefined))
  if (selected.size === 0) return []

  const patches: SchemaPatch[] = []
  for (const [parentId, node] of Object.entries(schema.nodes)) {
    // children 与各具名插槽各自是一层序列：层叠只在同一数组里有意义
    const lists: Array<{
      /** 具名插槽；省略表示 `children` 数组 */
      slot?: string
      /** 该序列当前的节点 id，按渲染顺序 */
      items: string[]
    }> = []
    if (node.children) lists.push({ items: node.children })
    for (const [slot, items] of Object.entries(node.slots ?? {})) lists.push({ slot, items })

    for (const { slot, items } of lists) {
      if (!items.some((id) => selected.has(id))) continue
      const next = shiftLayer(items, selected, mode)
      if (next.every((id, index) => id === items[index])) continue
      patches.push({ op: 'replace', path: childPath(parentId, slot), value: next })
    }
  }

  return patches
}

/** 在一组兄弟节点里按方位移动被选中的那些 */
function shiftLayer(items: readonly string[], selected: ReadonlySet<string>, mode: OrderMode) {
  const moved = items.filter((id) => selected.has(id))
  const rest = items.filter((id) => !selected.has(id))
  if (mode === 'front') return [...rest, ...moved]
  if (mode === 'back') return [...moved, ...rest]

  const next = [...items]
  // 逐层移动从目标方向的一侧扫起，保证一串相邻的选中节点整体平移而不是互相抢位
  const indexes =
    mode === 'forward'
      ? [...next.keys()].reverse()
      : [...next.keys()].filter((index) => index > 0)

  for (const index of indexes) {
    const target = mode === 'forward' ? index + 1 : index - 1
    if (target >= next.length || target < 0) continue
    const current = next[index] as string
    const neighbour = next[target] as string
    if (!selected.has(current) || selected.has(neighbour)) continue
    next[index] = neighbour
    next[target] = current
  }

  return next
}

/** 一组节点矩形的并集；空集合返回 undefined */
function unionRects(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** 选中集里的最外层成员：框选常同时圈中容器与它的子节点，后代已随父级一起进组 */
function outermostMembers(schema: PageSchema, ids: readonly string[]): string[] {
  const present = ids.filter((id) => id !== schema.nodeId && schema.nodes[id] !== undefined)
  const descendants = new Set<string>()
  for (const id of present) {
    const node = schema.nodes[id]
    if (node)
      for (const childId of collectSubtree(schema, childRefs(node))) descendants.add(childId)
  }
  return present.filter((id) => !descendants.has(id))
}

/** 成员在原父级里最靠前的位置；新组接替它，层叠位置才不会随选中顺序漂移 */
function findGroupAnchor(
  schema: PageSchema,
  members: readonly string[],
): NodePosition | undefined {
  let anchor: NodePosition | undefined
  for (const id of members) {
    const position = findPosition(schema, id)
    if (position && (!anchor || position.index < anchor.index)) anchor = position
  }
  return anchor
}

/** 成员矩形的并集，作为新组的几何边界；没有 layout.rect 的成员不参与计算 */
function groupBounds(schema: PageSchema, members: readonly string[]): Rect | undefined {
  return unionRects(
    members
      .map((id) => schema.nodes[id]?.layout?.rect)
      .filter((item): item is Rect => item !== undefined),
  )
}

/** 把新组插回锚点所在数组；成员已摘除，插入下标要按摘除后的长度夹住 */
function attachAtAnchor(
  schema: PageSchema,
  anchor: NodePosition,
  groupId: string,
  members: readonly string[],
): SchemaPatch[] {
  const parent = schema.nodes[anchor.parentId]
  const siblings = childArray(parent, anchor.slot).filter((id) => !members.includes(id))
  return [
    {
      op: 'replace',
      path: childPath(anchor.parentId, anchor.slot),
      value: insertAt(siblings, groupId, Math.min(anchor.index, siblings.length)),
    },
  ]
}

/** 成员全是游离节点时的兜底：新组挂到文档根，否则它在树里无处安放 */
function attachToDocumentRoot(schema: PageSchema, groupId: string): SchemaPatch[] {
  const root = schema.nodes[schema.nodeId]
  return [
    {
      op: 'replace',
      path: `${nodePath(schema.nodeId)}/children`,
      value: [...(root?.children ?? []), groupId],
    },
  ]
}

/**
 * 新建的组节点：absolute 布局，rect 取成员并集。
 *
 * 成员无有效 `layout.rect` 时 `rect` 缺省（不写 `undefined` 键），交由渲染层回落到
 * 默认几何；组内顺序沿用传入的 members（即选中集顺序）。
 */
function buildGroupNode(
  groupId: string,
  name: string,
  members: string[],
  rect: Rect | undefined,
): NodeSchema {
  return {
    id: groupId,
    componentName: 'Group',
    name,
    children: members,
    layout: { mode: 'absolute', ...(rect ? { rect } : {}) },
  }
}

/**
 * 把一组节点包进新分组。
 *
 * 成员的 `layout.rect` 是世界坐标、渲染时按父级原点做补偿，所以换父级不改变
 * 视觉位置，跨父级的选中集也能直接组合。新组接替成员里最靠前的那个位置（层叠
 * 位置不随选中顺序漂移），组内顺序沿用传入顺序（即选中集顺序）。
 * 少于 2 个有效节点、或节点不在文档里时返回 undefined，调用方据此不做任何写入。
 *
 * @param options.createId 新组 id 的生成器；由调用方注入，树操作层不自行造 id，以免与命令历史里的 id 源分叉
 * @param options.name 图层树显示名；未传时写「分组」，传空串则原样保留空名
 */
export function groupNodes(
  schema: PageSchema,
  ids: readonly string[],
  options: { createId: () => string; name?: string },
): GroupResult | undefined {
  const members = outermostMembers(schema, ids)
  if (members.length < 2) return undefined

  const groupId = options.createId()
  const anchor = findGroupAnchor(schema, members)
  const rect = groupBounds(schema, members)
  const group = buildGroupNode(groupId, options.name ?? '分组', members, rect)

  const patches: SchemaPatch[] = [
    ...detachFromParents(schema, new Set(members)),
    { op: 'add', path: nodePath(groupId), value: group },
    ...(anchor
      ? attachAtAnchor(schema, anchor, groupId, members)
      : attachToDocumentRoot(schema, groupId)),
  ]

  return { patches, groupId }
}

function insertAt(items: readonly string[], value: string, index: number): string[] {
  const next = [...items]
  next.splice(clamp(index, 0, next.length), 0, value)
  return next
}

/**
 * 解散分组：组节点从父级里摘掉，其成员按原顺序接到组所在的位置上。
 *
 * 只对确实带子节点的节点生效，属性面板里被改坏的「假组」不会被静默展开成空引用。
 * 组所在父级的数组由补位 patch 覆盖（同路径后写生效），`detachFromParents` 负责
 * 清掉其他父级可能残留的同一个引用。
 */
export function ungroupNodes(schema: PageSchema, ids: readonly string[]): SchemaPatch[] {
  const groups = ids
    .map((id) => schema.nodes[id])
    .filter(
      (node): node is NodeSchema => node !== undefined && (node.children?.length ?? 0) > 0,
    )
  if (groups.length === 0) return []

  const patches: SchemaPatch[] = detachFromParents(
    schema,
    new Set(groups.map((group) => group.id)),
  )

  for (const group of groups) {
    const position = findPosition(schema, group.id)
    if (position) {
      const parent = schema.nodes[position.parentId]
      const next = [...childArray(parent, position.slot)]
      next.splice(position.index, 1, ...(group.children ?? []))
      patches.push({
        op: 'replace',
        path: childPath(position.parentId, position.slot),
        value: next.filter((id) => id !== group.id),
      })
    }
    patches.push({ op: 'remove', path: nodePath(group.id) })
  }

  return patches
}

/**
 * 批量改写节点的显隐 / 锁定开关。
 *
 * 一次 replace 整个字段而不是 remove：图层树与命令面板都要能稳定读到布尔值。
 */
export function setNodeFlags(
  schema: PageSchema,
  ids: readonly string[],
  flags: NodeFlagChange,
): SchemaPatch[] {
  const entries = Object.entries(flags).filter(([, value]) => value !== undefined)
  return ids.flatMap((id) =>
    schema.nodes[id] === undefined
      ? []
      : entries.map(([field, value]) => ({
          op: 'replace' as const,
          path: `${nodePath(id)}/${field}`,
          value,
        })),
  )
}

/** 改写图层树显示名；空字符串按「恢复显示组件名」处理，直接删掉 name 字段 */
export function renameNode(schema: PageSchema, nodeId: string, name: string): SchemaPatch[] {
  if (schema.nodes[nodeId] === undefined) return []
  const trimmed = name.trim()
  return trimmed.length > 0
    ? [{ op: 'replace', path: `${nodePath(nodeId)}/name`, value: trimmed }]
    : [{ op: 'remove', path: `${nodePath(nodeId)}/name` }]
}
