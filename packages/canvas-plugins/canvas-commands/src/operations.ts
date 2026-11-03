import type { SchemaPatch } from '@lc/contracts'
import type { NodeSchema, PageSchema } from '@lc/schema'
import {
  childRefs,
  collectSubtree,
  createNodeLayoutPatch,
  detachFromParents,
  nodePath,
} from '@lc/schema'

/**
 * 一组可插入的子树快照。
 *
 * `parents` 记录每个根节点原来的父级（没有父级时 undefined），
 * 粘贴/再制时优先回到原父级，父级已删除则回退到文档根节点。
 */
export interface SubtreeSet {
  /** 子树节点表（深拷贝） */
  nodes: Record<string, NodeSchema>
  /** 选中集的根节点 id */
  roots: string[]
  /** 根节点 → 原父节点 */
  parents: Record<string, string | undefined>
}

/** 插入结果 */
export interface InsertResult {
  /**
   * 可直接提交事务的补丁序列：先逐节点 add，再按父级 replace children；
   * 顺序保证 add 先于引用生效，父级缺失时不会产生悬空 children。
   */
  patches: SchemaPatch[]
  /** 新根节点 id，用于插入后选中 */
  newRootIds: string[]
}

/**
 * `insertSubtrees` 的定位参数。
 *
 * 复制与再制共用同一插入逻辑，差异只在偏移量；`createId` 注入是为了
 * 让单测得到确定的 id 序列。
 */
export interface InsertOptions {
  /** 新节点整体偏移（世界像素） */
  offset: number
  /** id 生成器；测试可注入确定性实现 */
  createId: () => string
}

function cloneNode<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function findParent(schema: PageSchema, nodeId: string): string | undefined {
  for (const [parentId, node] of Object.entries(schema.nodes)) {
    if (childRefs(node).includes(nodeId)) return parentId
  }
  return undefined
}

/** 复制选中节点的完整子树（含后代），返回可重复粘贴的快照。 */
export function copySubtrees(schema: PageSchema, ids: readonly string[]): SubtreeSet {
  const roots = ids.filter((id) => Boolean(schema.nodes[id]))
  const collected = collectSubtree(schema, roots)

  const nodes: Record<string, NodeSchema> = {}
  for (const id of collected) {
    const node = schema.nodes[id]
    if (node) nodes[id] = cloneNode(node)
  }

  const parents: Record<string, string | undefined> = {}
  for (const root of roots) parents[root] = findParent(schema, root)

  return { nodes, roots, parents }
}

/**
 * 把子树快照插入当前文档。
 *
 * 每个节点都会获得新 id 并整体偏移；子节点引用按 idMap 重映射。
 * 根节点追加到原父级（或文档根节点）的 children 末尾。
 */
export function insertSubtrees(
  schema: PageSchema,
  source: SubtreeSet,
  options: InsertOptions,
): InsertResult {
  const idMap = planIdMap(source.nodes, options.createId)

  // 先逐节点 add，再按父级 replace children：顺序保证引用生效时目标节点已在文档里
  const patches = [
    ...planNodeAdds(source.nodes, idMap, options.offset),
    ...planParentPatches(schema, planRootAppends(schema, source, idMap)),
  ]

  // 新根顺序跟随 source.roots：选中集顺序决定 primary，不能按父级分组重排
  return { patches, newRootIds: remapIds(source.roots, idMap) }
}

/**
 * 为复制集合里的每个旧 id 预先分配新 id。
 *
 * 一次插入共用同一张映射表，节点自身 id、children 引用与新根 id 才不会互相错位。
 */
function planIdMap(
  nodes: Readonly<Record<string, NodeSchema>>,
  createId: () => string,
): Map<string, string> {
  const idMap = new Map<string, string>()
  for (const oldId of Object.keys(nodes)) idMap.set(oldId, createId())
  return idMap
}

/** 逐节点 add 补丁；path 用新 id，值由 `cloneWithNewId` 完成换 id、重映射与平移 */
function planNodeAdds(
  nodes: Readonly<Record<string, NodeSchema>>,
  idMap: Map<string, string>,
  offset: number,
): SchemaPatch[] {
  const patches: SchemaPatch[] = []

  for (const [oldId, node] of Object.entries(nodes)) {
    // idMap 覆盖了 source.nodes 的全部键，取值必命中
    const newId = idMap.get(oldId) as string
    patches.push({
      op: 'add',
      path: nodePath(newId),
      value: cloneWithNewId(node, newId, idMap, offset),
    })
  }

  return patches
}

/**
 * 父级 children 的 replace 补丁。
 *
 * 在当前 children 末尾追加该父级名下的新根；父级已被删除时 `planRootAppends`
 * 已把它归到文档根节点，这里不会再产生悬空引用。
 */
function planParentPatches(schema: PageSchema, appends: Map<string, string[]>): SchemaPatch[] {
  const patches: SchemaPatch[] = []

  for (const [parentId, children] of appends) {
    const current = schema.nodes[parentId]?.children ?? []
    patches.push({
      op: 'replace',
      path: nodePath(parentId, 'children'),
      value: [...current, ...children],
    })
  }

  return patches
}

/** children、slot 与新根列表共用：旧 id → 新 id，映射不到的（不在本次复制集合里）丢弃 */
function remapIds(childIds: readonly string[], idMap: Map<string, string>): string[] {
  return childIds
    .map((childId) => idMap.get(childId))
    .filter((childId): childId is string => childId !== undefined)
}

/**
 * 深拷贝单个节点并改写身份：换新 id、重映射子引用、整体平移。
 *
 * rect 平移同时作用于 x/y 两个轴（与 `InsertOptions.offset` 的对角偏移语义一致）；
 * 没有 rect 的流式布局节点原样保留 layout。
 */
function cloneWithNewId(
  node: NodeSchema,
  newId: string,
  idMap: Map<string, string>,
  offset: number,
): NodeSchema {
  const rect = node.layout?.rect
  return {
    ...cloneNode(node),
    id: newId,
    children: node.children ? remapIds(node.children, idMap) : undefined,
    slots: node.slots
      ? Object.fromEntries(
          Object.entries(node.slots).map(([slot, children]) => [
            slot,
            remapIds(children, idMap),
          ]),
        )
      : undefined,
    layout: rect
      ? {
          ...node.layout,
          rect: {
            ...rect,
            x: rect.x + offset,
            y: rect.y + offset,
          },
        }
      : node.layout,
  }
}

/**
 * 规划各根节点的挂载：新根 id → 追加到哪个父级的 children。
 *
 * 原父级仍在文档里就回原父级末尾，否则退到文档根节点；同一父级的多个根
 * 保持 source.roots 的相对顺序。
 */
function planRootAppends(
  schema: PageSchema,
  source: SubtreeSet,
  idMap: Map<string, string>,
): Map<string, string[]> {
  const appends = new Map<string, string[]>()

  for (const root of source.roots) {
    const mappedRoot = idMap.get(root)
    if (!mappedRoot) continue

    const storedParent = source.parents[root]
    const parentId = storedParent && schema.nodes[storedParent] ? storedParent : schema.nodeId

    const list = appends.get(parentId) ?? []
    list.push(mappedRoot)
    appends.set(parentId, list)
  }

  return appends
}

/**
 * 删除选中节点（含其子树）：移除节点表条目，并从所有父节点的 children/slots 中剔除引用。
 *
 * 文档根节点不可删除；传入根节点会被忽略。
 */
export function deleteSelection(schema: PageSchema, ids: readonly string[]): SchemaPatch[] {
  const roots = ids.filter((id) => id !== schema.nodeId && Boolean(schema.nodes[id]))
  if (roots.length === 0) return []

  const removed = collectSubtree(schema, roots)

  const patches: SchemaPatch[] = []
  for (const id of removed) patches.push({ op: 'remove', path: nodePath(id) })
  // 引用清理交给树操作：集合内的节点自身不再产生 patch，随 remove 一起消失
  patches.push(...detachFromParents(schema, removed))

  return patches
}

/** 方向键微调：只平移位置，不改尺寸。 */
export function nudgeSelection(
  schema: PageSchema,
  ids: readonly string[],
  dx: number,
  dy: number,
): SchemaPatch[] {
  const patches: SchemaPatch[] = []

  for (const id of ids) {
    const rect = schema.nodes[id]?.layout?.rect
    if (!rect) continue
    patches.push(
      ...createNodeLayoutPatch(id, { rect: { ...rect, x: rect.x + dx, y: rect.y + dy } }),
    )
  }

  return patches
}
