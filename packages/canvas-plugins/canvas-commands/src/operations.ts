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
  patches: SchemaPatch[]
  /** 新根节点 id，用于插入后选中 */
  newRootIds: string[]
}

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
  const idMap = new Map<string, string>()
  for (const oldId of Object.keys(source.nodes)) idMap.set(oldId, options.createId())

  const patches: SchemaPatch[] = []
  for (const [oldId, node] of Object.entries(source.nodes)) {
    const newId = idMap.get(oldId) as string
    const mappedChildren = node.children
      ?.map((childId) => idMap.get(childId))
      .filter((childId): childId is string => Boolean(childId))
    const mappedSlots = node.slots
      ? Object.fromEntries(
          Object.entries(node.slots).map(([slot, children]) => [
            slot,
            children
              .map((childId) => idMap.get(childId))
              .filter((childId): childId is string => Boolean(childId)),
          ]),
        )
      : undefined

    const rect = node.layout?.rect
    const next: NodeSchema = {
      ...cloneNode(node),
      id: newId,
      children: mappedChildren,
      slots: mappedSlots,
      layout: rect
        ? {
            ...node.layout,
            rect: {
              ...rect,
              x: rect.x + options.offset,
              y: rect.y + options.offset,
            },
          }
        : node.layout,
    }

    patches.push({ op: 'add', path: nodePath(newId), value: next })
  }

  const appends = new Map<string, string[]>()
  const newRootIds: string[] = []

  for (const root of source.roots) {
    const mappedRoot = idMap.get(root)
    if (!mappedRoot) continue

    const storedParent = source.parents[root]
    const parentId = storedParent && schema.nodes[storedParent] ? storedParent : schema.nodeId

    newRootIds.push(mappedRoot)
    const list = appends.get(parentId) ?? []
    list.push(mappedRoot)
    appends.set(parentId, list)
  }

  for (const [parentId, children] of appends) {
    const parent = schema.nodes[parentId]
    const current = parent?.children ?? []
    patches.push({
      op: 'replace',
      path: nodePath(parentId, 'children'),
      value: [...current, ...children],
    })
  }

  return { patches, newRootIds }
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
