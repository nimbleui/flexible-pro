import type { Context, PluginRecord, ServiceScope } from '@lc/kernel'
import type { Contributions, LoaderService, PluginManifest } from '@lc/contracts'
import { describeError } from '../format'
import type { ContributionCount, DevtoolsScope, ManifestSummary, PluginRow } from '../types'

/** 贡献计数：只统计非空数组，按类型名排序，避免每次刷新顺序抖动。 */
function countContributions(contributes: Contributions | undefined): ContributionCount[] {
  if (!contributes) return []
  return Object.entries(contributes)
    .filter(
      (entry): entry is [string, unknown[]] => Array.isArray(entry[1]) && entry[1].length > 0,
    )
    .map(([kind, items]) => ({ kind, count: items.length }))
    .sort((a, b) => a.kind.localeCompare(b.kind))
}

function toManifestSummary(manifest: PluginManifest, loader?: LoaderService): ManifestSummary {
  return {
    displayName: manifest.displayName,
    version: manifest.version,
    certification: manifest.certification,
    executionProfile: manifest.executionProfile,
    activated: loader?.isActivated(manifest.name) ?? false,
    contributions: countContributions(manifest.contributes),
  }
}

/** 清单字段：只在 loader 扫描得到对应 manifest 时写入，纯内核场景不出现该 key。 */
function manifestField(
  manifest: PluginManifest | undefined,
  loader: LoaderService | undefined,
): Partial<PluginRow> {
  return manifest ? { manifest: toManifestSummary(manifest, loader) } : {}
}

/**
 * 装配过程才会产生的字段。
 *
 * 没跑过就不写 key（而不是写 undefined），面板据此区分「没有耗时」和「耗时 0 ms」。
 */
function assemblyFields(record: PluginRecord): Partial<PluginRow> {
  const fields: Partial<PluginRow> = {}
  if (record.activatedAt !== undefined) fields.activatedAt = record.activatedAt
  if (record.applyMs !== undefined) fields.applyMs = record.applyMs
  if (record.error !== undefined) fields.error = describeError(record.error)
  return fields
}

/**
 * 单条实例记录 → 插件树的一行。
 *
 * `required` / `optional` / `provides` 直接引用记录里的声明数组（内核不会改它们），
 * 只有 `missing` 与 `error` 是每次重算的产物；`owned` 来自本作用域服务表的分组结果。
 */
function toRow(
  record: PluginRecord,
  scopeId: string,
  depth: number,
  resolver: Context,
  owned: Map<string, string[]>,
  manifests: Map<string, PluginManifest>,
  loader: LoaderService | undefined,
): PluginRow {
  return {
    id: record.id,
    name: record.name,
    scopeId,
    depth,
    parentId: depth === 0 ? null : (record.parent?.id ?? null),
    state: record.state,
    required: record.inject.required,
    optional: record.inject.optional,
    missing: record.inject.required.filter((name) => resolver.get(name) === undefined),
    provides: record.provides,
    owned: owned.get(record.id) ?? [],
    attempts: record.attempts,
    ...assemblyFields(record),
    ...manifestField(manifests.get(record.name), loader),
  }
}

function walkRecords(
  children: ReadonlySet<PluginRecord>,
  scopeId: string,
  depth: number,
  resolver: Context,
  out: PluginRow[],
  owned: Map<string, string[]>,
  manifests: Map<string, PluginManifest>,
  loader: LoaderService | undefined,
): void {
  for (const record of children) {
    out.push(toRow(record, scopeId, depth, resolver, owned, manifests, loader))
    if (record.context) {
      walkRecords(
        record.context.children,
        scopeId,
        depth + 1,
        record.context,
        out,
        owned,
        manifests,
        loader,
      )
    }
  }
}

function indexManifests(loader: LoaderService | undefined): Map<string, PluginManifest> {
  const manifests = new Map<string, PluginManifest>()
  if (!loader) return manifests
  for (const manifest of loader.scan()) manifests.set(manifest.name, manifest)
  return manifests
}

function groupServicesByOwner(scope: ServiceScope): Map<string, string[]> {
  const owned = new Map<string, string[]>()
  for (const [name, entry] of scope.services) {
    const list = owned.get(entry.owner.id)
    if (list) list.push(name)
    else owned.set(entry.owner.id, [name])
  }
  return owned
}

/**
 * 插件树展平结果。
 *
 * 每个作用域从 `context.children` 向下递归，靠 `record.context` 进入子树：
 * 停在 pending / failed 的实例没有自己的 Context，但它仍在父级 `children` 里，
 * 因此「起不来的插件」同样会出现在树上。
 */
export function collectPlugins(scopes: readonly DevtoolsScope[]): PluginRow[] {
  const root = scopes.find((scope) => scope.parentId === null)?.context
  const loader = root?.get<LoaderService>('loader')
  const manifests = indexManifests(loader)

  const rows: PluginRow[] = []
  for (const scope of scopes) {
    const owned = groupServicesByOwner(scope.context.scope)
    walkRecords(
      scope.context.children,
      scope.id,
      0,
      scope.context,
      rows,
      owned,
      manifests,
      loader,
    )
  }
  return rows
}
