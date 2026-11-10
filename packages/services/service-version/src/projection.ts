import type { VersionDocKind, VersionDocument, WorkingTree } from '@lc/contracts'

/** 结构版本缺省值；宿主适配器未显式给出时使用。 */
export const DEFAULT_DOC_SCHEMA_VERSION = '1.0.0'

/**
 * 内核侧的一条资产记录。
 *
 * 刻意不引用 `apps/host` 的 `ProjectReleaseAssets` / `PageRecord`：依赖方向是
 * apps → services，反过来会让内核包绑死宿主数据结构。宿主只需写一个
 * 「五类资产 → records[]」的纯适配器，本文件负责与版本库之间的双向投影。
 */
export interface VersionAssetRecord {
  /** 资产记录 id，与 `WorkingTree` 的键一致 */
  id: string
  /** 资产种类 */
  kind: VersionDocKind
  /** 顶层字段名 → 值；page 直接放 `PageSchema` 的字段，其余类别按自身结构拆 */
  content: Record<string, unknown>
  /** @default '1.0.0' */
  docSchemaVersion?: string
}

/** 项目在某一时刻的五类资产快照（导入存量与新提交共用）。 */
export interface VersionAssetSnapshot {
  /** 五类资产记录列表，按 id 排序后投影为工作区 */
  records: readonly VersionAssetRecord[]
}

/** 资产快照 → 工作区；键按 id 排序，保证同一输入恒得同一棵提交树。 */
export function toWorkingTree(snapshot: VersionAssetSnapshot): WorkingTree {
  const tree: WorkingTree = {}

  for (const record of [...snapshot.records].sort((a, b) => a.id.localeCompare(b.id))) {
    tree[record.id] = {
      kind: record.kind,
      docSchemaVersion: record.docSchemaVersion ?? DEFAULT_DOC_SCHEMA_VERSION,
      sections: { ...record.content },
    }
  }

  return tree
}

/** 工作区 → 资产快照；检出后由宿主适配器据此回写五类资产。 */
export function fromWorkingTree(tree: WorkingTree): VersionAssetSnapshot {
  const records: VersionAssetRecord[] = []

  for (const id of Object.keys(tree).sort()) {
    const document: VersionDocument = tree[id]
    records.push({
      id,
      kind: document.kind,
      docSchemaVersion: document.docSchemaVersion,
      content: { ...document.sections },
    })
  }

  return { records }
}
