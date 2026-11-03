/**
 * 依赖图重算：需求边、阻塞插件、候选提供者与等待环。
 *
 * 内核不产出这些结论，全部在插件表与服务表之上按声明重算，因此只存在于 devtools 侧。
 */

import type { PluginManifest } from '@lc/contracts'
import type {
  BlockedPlugin,
  BlockedProvider,
  DependencyEdge,
  DependencyView,
  DevtoolsScope,
  MissingServiceCandidate,
  PluginRow,
  ServiceRow,
} from '../types'

/** 索引键：作用域 + 服务名；用 NUL 分隔，避免名字本身含分隔符时撞键。 */
function scopeKey(scopeId: string, name: string): string {
  return `${scopeId}\u0000${name}`
}

function indexScopes(scopes: readonly DevtoolsScope[]): Map<string, DevtoolsScope> {
  const index = new Map<string, DevtoolsScope>()
  for (const scope of scopes) index.set(scope.id, scope)
  return index
}

/** 服务索引：同名服务在不同层是不同条目，键必须带作用域。 */
function indexServices(services: readonly ServiceRow[]): Map<string, ServiceRow> {
  const index = new Map<string, ServiceRow>()
  for (const row of services) index.set(scopeKey(row.scopeId, row.name), row)
  return index
}

function parentOf(
  scope: DevtoolsScope,
  index: Map<string, DevtoolsScope>,
): DevtoolsScope | undefined {
  if (scope.parentId === null) return undefined
  return index.get(scope.parentId)
}

/**
 * 沿作用域链找到实际会被取到的提供者；与 `Context.get` 的查找方向一致。
 *
 * 只认已登记的作用域层：宿主没传进来的中间层看不见，解析结果会偏乐观，
 * 但 devtools 展示的是「自省范围内的世界」，与内核真实取值的一致性由
 * `collectScopes` 负责补齐。
 */
function findProvider(
  scopeId: string,
  service: string,
  scopes: Map<string, DevtoolsScope>,
  services: Map<string, ServiceRow>,
): ServiceRow | undefined {
  for (let current = scopes.get(scopeId); current; current = parentOf(current, scopes)) {
    const row = services.get(scopeKey(current.id, service))
    if (row) return row
  }
  return undefined
}

function edgeOf(
  row: PluginRow,
  service: string,
  required: boolean,
  provider: ServiceRow | undefined,
): DependencyEdge {
  return {
    from: row.id,
    fromName: row.name,
    scopeId: row.scopeId,
    service,
    required,
    to: provider?.ownerId ?? null,
    toName: provider?.ownerName ?? null,
  }
}

/**
 * 出边：必需在前、可选在后，与声明顺序一致。
 *
 * 解析不到也照样出边（`to` 为 null），这样「悬空需求」在图上可见，
 * 而不是只在阻塞列表里出现一次。
 */
function buildEdges(
  rows: readonly PluginRow[],
  scopes: Map<string, DevtoolsScope>,
  services: Map<string, ServiceRow>,
): DependencyEdge[] {
  const edges: DependencyEdge[] = []

  for (const row of rows) {
    for (const service of row.required) {
      const provider = findProvider(row.scopeId, service, scopes, services)
      edges.push(edgeOf(row, service, true, provider))
    }
    for (const service of row.optional) {
      const provider = findProvider(row.scopeId, service, scopes, services)
      edges.push(edgeOf(row, service, false, provider))
    }
  }

  return edges
}

/**
 * 每个缺失服务的候选来源。
 *
 * `providers` 只按 `provides` 声明匹配，不看是否真的解析得到：候选本身也停在
 * pending 时，连锁阻塞要在面板里说出来。`unactivated` 补上清单里声明了该服务
 * 但尚未加载的插件，两个集合相加才是「这个服务可能由谁给」的完整答案。
 */
function missingCandidates(
  row: PluginRow,
  rows: readonly PluginRow[],
  manifests: readonly PluginManifest[],
  loadedNames: ReadonlySet<string>,
): MissingServiceCandidate[] {
  return row.missing.map((service): MissingServiceCandidate => ({
    service,
    providers: rows
      .filter((other) => other.id !== row.id && other.provides.includes(service))
      .map((other): BlockedProvider => ({
        id: other.id,
        name: other.name,
        missing: other.missing,
      })),
    unactivated: manifests
      .filter(
        (manifest) =>
          !loadedNames.has(manifest.name) && (manifest.provides ?? []).includes(service),
      )
      .map((manifest) => manifest.name),
  }))
}

function buildBlockedPlugins(
  rows: readonly PluginRow[],
  manifests: readonly PluginManifest[],
): BlockedPlugin[] {
  const loadedNames = new Set(rows.map((row) => row.name))

  return rows
    .filter((row) => row.state === 'pending' || row.state === 'failed')
    .map((row): BlockedPlugin => ({
      id: row.id,
      name: row.name,
      scopeId: row.scopeId,
      state: row.state,
      missing: row.missing,
      error: row.error,
      candidates: missingCandidates(row, rows, manifests, loadedNames),
    }))
}

/**
 * 「谁在等谁」的邻接表。
 *
 * 只能按 `provides` 声明连边：pending 插件还没交付服务，解析后的依赖边上双方都是
 * 空的，真正的互相等待关系在解析结果里根本不存在。两端都卡住才算等待。
 */
function waitingFor(
  blocked: readonly BlockedPlugin[],
  blockedIds: ReadonlySet<string>,
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()
  for (const row of blocked) {
    for (const candidate of row.candidates) {
      for (const provider of candidate.providers) {
        if (provider.id === row.id || !blockedIds.has(provider.id)) continue
        const list = adjacency.get(row.id)
        if (!list) adjacency.set(row.id, [provider.id])
        else if (!list.includes(provider.id)) list.push(provider.id)
      }
    }
  }
  return adjacency
}

/**
 * 在等待关系里找环。
 *
 * 同一个环只报告一次，按成员排序后的 key 去重；内核不求解依赖图，
 * 这里的作用是把「双方都停在 pending」显式指出来，而不是让人去猜。
 */
function findCycles(adjacency: Map<string, string[]>): string[][] {
  const cycles: string[][] = []
  const reported = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []
  const onStack = new Set<string>()

  const visit = (id: string): void => {
    stack.push(id)
    onStack.add(id)

    for (const next of adjacency.get(id) ?? []) {
      if (onStack.has(next)) {
        const cycle = stack.slice(stack.indexOf(next))
        const key = [...cycle].sort().join('\u0000')
        if (!reported.has(key)) {
          reported.add(key)
          cycles.push(cycle)
        }
      } else if (!visited.has(next)) {
        visit(next)
      }
    }

    stack.pop()
    onStack.delete(id)
    visited.add(id)
  }

  for (const id of adjacency.keys()) {
    if (!visited.has(id)) visit(id)
  }
  return cycles
}

/**
 * 依赖视图：需求边、卡住的插件与等待环。
 *
 * 内核不求解依赖图，也不做拓扑排序，所以「谁在等谁、为什么 pending」只能在外部
 * 按声明重算一遍：必需依赖解析不到就是卡住，卡住的插件彼此成环就是循环依赖。
 *
 * @param manifests 已登记的清单；用来指出「声明了该服务但还没加载」的插件，
 * 这类插件没有实例记录，不传就只剩运行时视角
 */
export function buildDependencies(
  rows: readonly PluginRow[],
  scopes: readonly DevtoolsScope[],
  services: readonly ServiceRow[],
  manifests: readonly PluginManifest[] = [],
): DependencyView {
  const scopeIndex = indexScopes(scopes)
  const serviceIndex = indexServices(services)

  const edges = buildEdges(rows, scopeIndex, serviceIndex)
  const blocked = buildBlockedPlugins(rows, manifests)
  const blockedIds = new Set(blocked.map((row) => row.id))

  return { edges, blocked, cycles: findCycles(waitingFor(blocked, blockedIds)) }
}
