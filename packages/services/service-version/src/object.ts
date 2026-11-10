import type {
  Commit,
  CommitTree,
  DocumentObject,
  ObjectHash,
  SectionObject,
  VersionDocument,
  VersionObject,
  VersionStore,
  WorkingTree,
} from '@lc/contracts'
import { canonicalJson, hashText } from '@lc/shared'
import { VersionError } from './errors'

const encoder = new TextEncoder()

/**
 * 构造一个 section 的内容对象。
 *
 * hash 的输入是「命名空间 + 规范化文本」：`docId` / `section` 是对象自带的元数据，
 * 而 `putObject` 要求同一地址的对象逐字段一致。只按 content 取址时，两个不同文档的
 * 同值 section（例如空对象 `{}`，在五类资产里极其常见）会得到同一地址却写出两个不同
 * 对象，被 fail-closed 检查误判成「规范化失效」。把命名空间纳入取址后，跨提交的同名
 * 同值 section 依然共享一份字节，跨文档各自独立，容量收益几乎不变。
 *
 * content 保持规范化文本本身，不反序列化再序列化：那会重新引入键序差异，等于破坏
 * 自己的寻址依据。`size` 统计 UTF-8 字节，只用于容量展示，不参与 hash。
 */
export function createSectionObject(
  docId: string,
  section: string,
  value: unknown,
): SectionObject {
  const content = canonicalJson(value)
  const address = canonicalJson({ docId, section, content })

  return {
    kind: 'section',
    hash: hashText(address),
    docId,
    section,
    content,
    size: encoder.encode(content).length,
  }
}

/**
 * 构造一个文档对象。
 *
 * 只存 section → hash，同一份 nodes 在多个提交里只占一份字节；
 * hash 覆盖 docKind / docSchemaVersion / sections 三者，避免「只换结构版本」被当成同一份内容。
 */
export function createDocumentObject(
  doc: VersionDocument,
  sections: Record<string, ObjectHash>,
): DocumentObject {
  const header = { docKind: doc.kind, docSchemaVersion: doc.docSchemaVersion, sections }

  return {
    kind: 'document',
    hash: hashText(canonicalJson(header)),
    docKind: doc.kind,
    sections,
    docSchemaVersion: doc.docSchemaVersion,
  }
}

/** 工作区全量内容 → 待写入的对象清单 + 提交树。遍历键排序，保证同一输入恒得同一输出。 */
export function buildTree(tree: WorkingTree): {
  objects: VersionObject[]
  commitTree: CommitTree
} {
  const objects: VersionObject[] = []
  const docs: Record<string, ObjectHash> = {}

  for (const docId of Object.keys(tree).sort()) {
    const doc = tree[docId]
    const sections: Record<string, ObjectHash> = {}

    for (const section of Object.keys(doc.sections).sort()) {
      const value = doc.sections[section]
      if (value === undefined) continue

      const object = createSectionObject(docId, section, value)
      objects.push(object)
      sections[section] = object.hash
    }

    const documentObject = createDocumentObject(doc, sections)
    objects.push(documentObject)
    docs[docId] = documentObject.hash
  }

  return { objects, commitTree: { docs } }
}

/** 从对象存储读回一份文档及其各 section 的解析值。 */
export async function readDocument(
  store: VersionStore,
  repoId: string,
  documentHash: ObjectHash,
): Promise<VersionDocument> {
  const documentObject = await store.getObject(repoId, documentHash)

  if (!documentObject || documentObject.kind !== 'document') {
    throw new VersionError('missing-object', `文档对象 ${documentHash} 不存在或类型不符`)
  }

  const sections: Record<string, unknown> = {}

  for (const [section, sectionHash] of Object.entries(documentObject.sections)) {
    const sectionObject = await store.getObject(repoId, sectionHash)

    if (!sectionObject || sectionObject.kind !== 'section') {
      throw new VersionError('missing-object', `section 对象 ${sectionHash} 不存在或类型不符`)
    }

    const value: unknown = JSON.parse(sectionObject.content)
    sections[section] = value
  }

  return {
    kind: documentObject.docKind,
    docSchemaVersion: documentObject.docSchemaVersion,
    sections,
  }
}

/** 把一棵提交树还原成工作区内容，供 checkout / restoreDoc 使用。 */
export async function readTreeAt(
  store: VersionStore,
  repoId: string,
  tree: CommitTree,
): Promise<WorkingTree> {
  const result: WorkingTree = {}

  for (const docId of Object.keys(tree.docs).sort()) {
    result[docId] = await readDocument(store, repoId, tree.docs[docId])
  }

  return result
}

/**
 * 把提交头规范化后取地址作为 commit id。
 *
 * `createdAt` 刻意排除：同一份内容由两个人在不同时刻提交应得到同一地址，
 * 否则 diff 会把「时间不同」当成内容不同。作者与消息仍在 hash 内，它们是提交语义的一部分。
 */
export function commitIdOf(commit: Omit<Commit, 'id'>): ObjectHash {
  const header = {
    repoId: commit.repoId,
    parents: commit.parents,
    tree: commit.tree,
    message: commit.message,
    author: commit.author,
    intents: commit.intents ?? null,
    publish: commit.publish ?? null,
  }

  return hashText(canonicalJson(header))
}
