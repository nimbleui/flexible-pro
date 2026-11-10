import type {
  CommitTree,
  DiffResult,
  EntityChange,
  ObjectHash,
  VersionStore,
} from '@lc/contracts'
import { canonicalJson } from '@lc/shared'
import { readDocument } from './object'

/**
 * 按叶子字段处理的 section。
 *
 * 这些是单对象而非实体字典，键代表字段路径而不是实体 id；用 `/字段名` 作 entityId，
 * 与「叶子字段用 JSON Pointer 作 id」保持一致。
 */
const LEAF_SECTIONS = new Set(['route', 'metadata', 'settings'])

/** 数组元素的稳定键：id 优先，其次是物料/变量常见的命名字段，最后退回索引。 */
function stableKeyOf(item: unknown, index: number): string {
  if (isRecord(item)) {
    for (const field of ['id', 'name', 'binding', 'key']) {
      const value = item[field]
      if (typeof value === 'string' && value !== '') return value
    }

    const meta = item.meta
    if (isRecord(meta) && typeof meta.name === 'string' && meta.name !== '') return meta.name
  }

  return `#${index}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把一个 section 值摊成「实体 id → 值」。
 *
 * 数组先按键转字典是必要的：数组下标进 patch 路径，换序会让每个元素的指针全变，
 * 等于所有元素都「被修改」。字典 section 天然以 id 为键，直接用键。
 */
export function entityMapOf(section: string, value: unknown): Map<string, unknown> {
  const result = new Map<string, unknown>()

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item === undefined) return

      const base = stableKeyOf(item, index)
      let key = base
      let suffix = 2
      while (result.has(key)) key = `${base}#${suffix++}`
      result.set(key, item)
    })

    return result
  }

  if (isRecord(value)) {
    const leaf = LEAF_SECTIONS.has(section)

    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      result.set(leaf ? `/${key}` : key, item)
    }

    return result
  }

  if (value !== undefined && value !== null) result.set('', value)

  return result
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/**
 * 两个提交树之间的实体级差异。
 *
 * 文档对象 hash 相同即整篇未变，直接跳过；section 值比较用规范化文本而不是 `===`，
 * 因为两侧可能来自不同写入路径、键序不同但内容相同。
 */
export async function diffTrees(
  store: VersionStore,
  repoId: string,
  fromTree: CommitTree,
  toTree: CommitTree,
  from: ObjectHash,
  to: ObjectHash,
): Promise<DiffResult> {
  const changes: EntityChange[] = []
  const addedDocs: string[] = []
  const removedDocs: string[] = []
  const unchangedDocs: string[] = []
  const docIds = [
    ...new Set([...Object.keys(fromTree.docs), ...Object.keys(toTree.docs)]),
  ].sort()

  for (const docId of docIds) {
    const fromHash = fromTree.docs[docId]
    const toHash = toTree.docs[docId]

    if (fromHash === undefined) {
      addedDocs.push(docId)
      await appendWholeDoc(store, repoId, docId, toHash, 'added', changes)
      continue
    }

    if (toHash === undefined) {
      removedDocs.push(docId)
      await appendWholeDoc(store, repoId, docId, fromHash, 'removed', changes)
      continue
    }

    if (fromHash === toHash) {
      unchangedDocs.push(docId)
      continue
    }

    const [before, after] = await Promise.all([
      readDocument(store, repoId, fromHash),
      readDocument(store, repoId, toHash),
    ])
    const sectionNames = [
      ...new Set([...Object.keys(before.sections), ...Object.keys(after.sections)]),
    ].sort()

    for (const section of sectionNames) {
      const left = entityMapOf(section, before.sections[section])
      const right = entityMapOf(section, after.sections[section])
      const entityIds = [...new Set([...left.keys(), ...right.keys()])].sort()

      for (const entityId of entityIds) {
        const base = left.get(entityId)
        const ours = right.get(entityId)

        if (!left.has(entityId)) {
          changes.push({ docId, section, entityId, change: 'added', ours })
        } else if (!right.has(entityId)) {
          changes.push({ docId, section, entityId, change: 'removed', base })
        } else if (!sameValue(base, ours)) {
          changes.push({ docId, section, entityId, change: 'modified', base, ours })
        }
      }
    }
  }

  return { from, to, changes, addedDocs, removedDocs, unchangedDocs }
}

/** 整篇新增/删除时，逐实体列出：UI 需要看到具体少了哪些节点，而不只是「少了一页」。 */
async function appendWholeDoc(
  store: VersionStore,
  repoId: string,
  docId: string,
  documentHash: ObjectHash | undefined,
  change: 'added' | 'removed',
  changes: EntityChange[],
): Promise<void> {
  if (documentHash === undefined) return

  const doc = await readDocument(store, repoId, documentHash)

  for (const section of Object.keys(doc.sections).sort()) {
    for (const [entityId, value] of [...entityMapOf(section, doc.sections[section])].sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      changes.push(
        change === 'added'
          ? { docId, section, entityId, change, ours: value }
          : { docId, section, entityId, change, base: value },
      )
    }
  }
}
