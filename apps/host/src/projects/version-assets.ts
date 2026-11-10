import type { VersionDocKind } from '@lc/contracts'
import type { VersionAssetRecord, VersionAssetSnapshot } from '@lc/service-version'
import type { ProjectReleaseAssets } from './release-model'

/**
 * 宿主五类资产与版本库工作区之间的纯适配器。
 *
 * 放在 apps 侧而不是内核侧：`ProjectReleaseAssets` 是宿主数据结构，内核包引用它会
 * 让依赖方向反转（`projection.ts` 已刻意只定义中立的 `VersionAssetSnapshot`）。
 * 本文件不读写任何 store，同一输入恒得同一输出。
 */

const DOC_KINDS: readonly VersionDocKind[] = ['page', 'flow', 'function', 'component', 'api']

function isVersionDocKind(value: string): value is VersionDocKind {
  return DOC_KINDS.some((kind) => kind === value)
}

/**
 * 给资产 id 加上类别命名空间。
 *
 * 五类资产的 id 各自独立生成，跨类别并不保证不重复；而 `WorkingTree` 以文档 id
 * 为唯一键，直接用原始 id 会让后写入的一类静默覆盖前一类，历史里凭空少一条资产。
 */
export function versionDocId(kind: VersionDocKind, id: string): string {
  return `${kind}:${id}`
}

/** 反解 `versionDocId`；格式不合法或类别未知时返回 undefined，供检出回写使用。 */
export function parseVersionDocId(
  docId: string,
): { kind: VersionDocKind; id: string } | undefined {
  const separator = docId.indexOf(':')
  if (separator <= 0) return undefined

  const kind = docId.slice(0, separator)
  const id = docId.slice(separator + 1)
  if (id === '' || !isVersionDocKind(kind)) return undefined

  return { kind, id }
}

/**
 * 本地写入时刻，不属于内容。
 *
 * 两台设备保存同一份内容会拿到不同时间，留着既破坏「同一内容同 hash」，又会让
 * 「只是重新保存一次」也生成一次空提交。检出回写时由宿主按当时时刻补齐。
 */
const TIME_METADATA: ReadonlySet<string> = new Set(['createdAt', 'updatedAt'])

/**
 * 摊平一条资产记录的顶层字段作为 section。
 *
 * `id` / `projectId` 保留，检出回写时才能还原记录外壳；时间元数据按上面的理由剔除。
 */
function sectionsOf(record: object): Record<string, unknown> {
  const entries: [string, unknown][] = Object.entries(record)
  const sections: Record<string, unknown> = {}

  for (const [key, value] of entries) {
    if (!TIME_METADATA.has(key)) sections[key] = value
  }

  return sections
}

/**
 * 把一次项目资产收集结果投影成版本库快照。
 *
 * 页面按 `PageSchema` 的顶层字段摊平：这与「section = 文档顶层字段」及
 * `projection.ts` 的既有约定一致，也让一次只改几个节点的保存只重写变化的那几个
 * section。`PageRecord` 外壳里 `title` 已由 `withTitle` 同步进
 * `schema.metadata.title`，`id` 在 docId 里，`projectId` 由 repoId 隐含，因此平铺
 * schema 不丢可还原信息。其余四类按各自记录的顶层字段摊平。
 *
 * `assets.environment` 刻意不进文档：环境值不入文档、只在发布时冻结，
 * 它属于 `PublishReceipt.environmentHash`，由发布路径在发布时冻结。`assets.apis`
 * 是五类资产之一，正常入文档。
 *
 * @throws 同类内出现重复 id 时抛错——fail-closed 而不是让 `toWorkingTree` 静默覆盖
 */
export function toVersionSnapshot(assets: ProjectReleaseAssets): VersionAssetSnapshot {
  const records: VersionAssetRecord[] = []

  const append = (kind: VersionDocKind, items: readonly { id: string }[]): void => {
    for (const item of items) {
      records.push({
        id: versionDocId(kind, item.id),
        kind,
        content: sectionsOf(item),
      })
    }
  }

  for (const page of assets.pages) {
    records.push({
      id: versionDocId('page', page.id),
      kind: 'page',
      docSchemaVersion: page.schema.version,
      content: sectionsOf(page.schema),
    })
  }

  append('flow', assets.flows)
  append('function', assets.functions)
  append('component', assets.components)
  append('api', assets.apis ?? [])

  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.id)) throw new Error(`[host] 版本库文档 id 冲突: ${record.id}`)
    seen.add(record.id)
  }

  return { records }
}
