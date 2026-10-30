import type { Context, PluginRecord, ServiceScope } from '@lc/kernel'
import { RESERVED_SERVICES } from '@lc/kernel'
import type {
  CanvasService,
  Contributions,
  DocumentService,
  HistoryService,
  LoaderService,
  PluginManifest,
  WorkspaceService,
} from '@lc/contracts'
import { describeError, summarizeValue } from './format'
import type {
  BlockedPlugin,
  BlockedProvider,
  CanvasView,
  ConfigOverride,
  ContributionCount,
  DependencyEdge,
  DependencyView,
  DevtoolsScope,
  ManifestSummary,
  MissingServiceCandidate,
  PluginConfigView,
  PluginRow,
  ServiceChainLink,
  ServiceRow,
} from './types'
import { ROOT_SCOPE_ID } from './types'

/**
 * 作用域枚举：应用根 + 文档 Realm + 宿主传入的画布层。
 *
 * Realm 与画布是 `ctx.fork()` 出来的，不进入 `Context.children`，从根树走不到；
 * 因此文档 Realm 靠 `workspace.listEditors()` 补齐，画布层只能由宿主告知。
 *
 * @param root 应用根上下文
 * @param canvas 当前画布上下文；省略则没有画布层
 */
export function collectScopes(root: Context, canvas?: Context | null): DevtoolsScope[] {
  const scopes: DevtoolsScope[] = [
    { id: ROOT_SCOPE_ID, label: '应用根', context: root, parentId: null },
  ]

  const workspace = root.get<WorkspaceService>('workspace')
  if (workspace) {
    for (const realm of workspace.listEditors()) {
      scopes.push({
        id: realm.id,
        label: `文档 ${realm.documentId}`,
        context: realm.context,
        parentId: ROOT_SCOPE_ID,
      })
    }
  }

  if (canvas) {
    const parentId = findKnownAncestorId(scopes, canvas.scope)
    scopes.push({
      id: `${parentId ?? ROOT_SCOPE_ID}/canvas`,
      label: '画布视图',
      context: canvas,
      parentId,
    })
  }

  return scopes
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

/**
 * 服务表：逐层列出实际注册的服务，并给出遮蔽链。
 *
 * 只列「哪一层注册了什么」，同一个名字在多个层出现就是多行，
 * 每行的 `chain` 说明本层取值时实际命中哪个提供者。
 */
export function collectServices(scopes: readonly DevtoolsScope[]): ServiceRow[] {
  const known = new Map<ServiceScope, DevtoolsScope>()
  for (const scope of scopes) known.set(scope.context.scope, scope)

  const rows: ServiceRow[] = []
  for (const scope of scopes) {
    for (const [name, entry] of scope.context.scope.services) {
      rows.push({
        name,
        scopeId: scope.id,
        ownerId: entry.owner.id,
        ownerName: entry.owner.name,
        apiVersion: entry.apiVersion,
        reserved: RESERVED_SERVICES.has(name),
        summary: summarizeValue(entry.value),
        chain: buildChain(scope, name, known),
      })
    }
  }
  return rows
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
  const scopeIndex = new Map<string, DevtoolsScope>()
  for (const scope of scopes) scopeIndex.set(scope.id, scope)

  const serviceIndex = new Map<string, ServiceRow>()
  for (const row of services) serviceIndex.set(scopeKey(row.scopeId, row.name), row)

  const loadedNames = new Set(rows.map((row) => row.name))

  /** 沿作用域链找到实际会被取到的提供者；与 `Context.get` 的查找方向一致。 */
  const findProvider = (scopeId: string, service: string): ServiceRow | undefined => {
    for (
      let current = scopeIndex.get(scopeId);
      current;
      current = parentOf(current, scopeIndex)
    ) {
      const row = serviceIndex.get(scopeKey(current.id, service))
      if (row) return row
    }
    return undefined
  }

  const edges: DependencyEdge[] = []
  for (const row of rows) {
    for (const service of row.required) {
      const provider = findProvider(row.scopeId, service)
      edges.push(edgeOf(row, service, true, provider))
    }
    for (const service of row.optional) {
      const provider = findProvider(row.scopeId, service)
      edges.push(edgeOf(row, service, false, provider))
    }
  }

  const blocked = rows
    .filter((row) => row.state === 'pending' || row.state === 'failed')
    .map((row): BlockedPlugin => ({
      id: row.id,
      name: row.name,
      scopeId: row.scopeId,
      state: row.state,
      missing: row.missing,
      error: row.error,
      candidates: row.missing.map((service): MissingServiceCandidate => ({
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
      })),
    }))

  const blockedIds = new Set(blocked.map((row) => row.id))
  return { edges, blocked, cycles: findCycles(waitingFor(blocked, blockedIds)) }
}

/**
 * 单个插件的配置视图：原始配置、解析结果与逐层覆盖来源。
 *
 * 合并只在激活时发生一次，所以「解析后的配置」对 pending / failed 实例是空的；
 * `overrides` 直接读各层 `intercepts`，能看出覆盖来自哪个 Realm 或哪个父插件。
 *
 * @returns 实例不存在时返回 null
 */
export function buildConfigView(
  scopes: readonly DevtoolsScope[],
  pluginId: string,
): PluginConfigView | null {
  const located = findRecord(scopes, pluginId)
  if (!located) return null

  const { record, context } = located
  const labelByContext = new Map<Context, DevtoolsScope>()
  for (const scope of scopes) labelByContext.set(scope.context, scope)

  const overrides: ConfigOverride[] = []
  const chain: Context[] = []
  for (let current: Context | null = context; current; current = current.parent) {
    chain.unshift(current)
  }
  for (const current of chain) {
    const patch = current.intercepts.get(record.name)
    if (!patch) continue
    const known = labelByContext.get(current)
    overrides.push({
      scopeId: known?.id ?? current.record.id,
      label: known?.label ?? `插件 ${current.record.name}`,
      patch,
    })
  }

  return {
    id: record.id,
    name: record.name,
    raw: record.rawConfig,
    resolved: record.config,
    overrides,
  }
}

/** 画布视图快照：视口、场景、覆盖层、交互处理器、选中集与文档状态。 */
export function buildCanvasView(canvas: Context | null | undefined): CanvasView | null {
  if (!canvas) return null
  const service = canvas.get<CanvasService>('canvas')
  if (!service) return null

  const document = canvas.get<DocumentService>('document')
  const history = canvas.get<HistoryService>('history')
  const schema = document?.model.schema
  const state = service.viewport.state
  const order = service.scene.list()

  return {
    viewport: {
      x: state.x,
      y: state.y,
      zoom: state.zoom,
      rotation: state.rotation,
      width: service.viewport.size.width,
      height: service.viewport.size.height,
    },
    scene: {
      count: order.length,
      order,
      rootBounds: service.scene.getRootBounds(),
    },
    layers: service.layers.list().map((layer) => ({
      id: layer.id,
      band: layer.band,
      zIndex: layer.zIndex ?? 0,
      pointerEvents: layer.pointerEvents ?? 'none',
    })),
    handlers: service.interaction.list().map((handler) => ({
      id: handler.id,
      phase: handler.phase ?? 'bubble',
      priority: handler.priority ?? 0,
    })),
    selection: {
      ids: service.selection.ids,
      primary: service.selection.primary ?? null,
    },
    flags: {
      hidden: [...service.nodeFlags.hidden],
      locked: [...service.nodeFlags.locked],
    },
    document: document?.model
      ? {
          id: document.model.id,
          title: document.model.title,
          schemaVersion: schema?.version ?? '-',
          revision: document.model.version,
          nodeCount: schema ? Object.keys(schema.nodes).length : 0,
          dirty: document.model.dirty,
        }
      : null,
    history: history
      ? { canUndo: history.canUndo, canRedo: history.canRedo, count: history.list().length }
      : null,
  }
}

/** 按实例 id 在全部作用域里找记录，并带回它的解析上下文。 */
export function findRecord(
  scopes: readonly DevtoolsScope[],
  pluginId: string,
): { record: PluginRecord; context: Context } | null {
  for (const scope of scopes) {
    const found = searchChildren(scope.context.children, pluginId, scope.context)
    if (found) return found
  }
  return null
}

function searchChildren(
  children: ReadonlySet<PluginRecord>,
  pluginId: string,
  resolver: Context,
): { record: PluginRecord; context: Context } | null {
  for (const record of children) {
    if (record.id === pluginId) return { record, context: resolver }
    if (!record.context) continue
    const found = searchChildren(record.context.children, pluginId, record.context)
    if (found) return found
  }
  return null
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

function toRow(
  record: PluginRecord,
  scopeId: string,
  depth: number,
  resolver: Context,
  owned: Map<string, string[]>,
  manifests: Map<string, PluginManifest>,
  loader: LoaderService | undefined,
): PluginRow {
  const manifest = manifests.get(record.name)
  const row: PluginRow = {
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
  }

  if (record.activatedAt !== undefined) row.activatedAt = record.activatedAt
  if (record.applyMs !== undefined) row.applyMs = record.applyMs
  if (record.error !== undefined) row.error = describeError(record.error)
  if (manifest) row.manifest = toManifestSummary(manifest, loader)

  return row
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
 * 从本层向上收集同名服务。
 *
 * `filter`（isolate 层）的处理与 `Context.get` 保持一致：名单外的名字整层跳过，
 * 否则 devtools 会报出一个和实际取值不符的遮蔽链。
 */
function buildChain(
  scope: DevtoolsScope,
  name: string,
  known: Map<ServiceScope, DevtoolsScope>,
): ServiceChainLink[] {
  const chain: ServiceChainLink[] = []
  for (
    let current: ServiceScope | undefined = scope.context.scope;
    current;
    current = current.parent
  ) {
    if (current.filter && !current.filter.has(name)) continue
    const entry = current.services.get(name)
    if (!entry) continue

    const layer = known.get(current)
    chain.push({
      scopeId: layer?.id ?? null,
      scopeLabel: layer?.label ?? '隔离层',
      ownerId: entry.owner.id,
      ownerName: entry.owner.name,
      apiVersion: entry.apiVersion,
      active: chain.length === 0,
    })
  }
  return chain
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

function parentOf(
  scope: DevtoolsScope,
  index: Map<string, DevtoolsScope>,
): DevtoolsScope | undefined {
  if (scope.parentId === null) return undefined
  return index.get(scope.parentId)
}

/** 索引键：作用域 + 服务名；用 NUL 分隔，避免名字本身含分隔符时撞键。 */
function scopeKey(scopeId: string, name: string): string {
  return `${scopeId}\u0000${name}`
}

/**
 * 向上找到第一个已登记的作用域层。
 *
 * 画布层由 Realm fork 而来，中间可能夹着宿主没传进来的层；认到最近的已知层，
 * 依赖解析链才不会在这里断掉，否则画布插件会显得「谁都提供不了它的依赖」。
 */
function findKnownAncestorId(
  scopes: readonly DevtoolsScope[],
  scope: ServiceScope,
): string | null {
  for (let current = scope.parent; current; current = current.parent) {
    for (const candidate of scopes) {
      if (candidate.context.scope === current) return candidate.id
    }
  }
  return null
}
