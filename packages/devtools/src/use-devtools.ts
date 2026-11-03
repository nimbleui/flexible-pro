import type { ComputedRef } from 'vue'
import { computed, onScopeDispose, ref } from 'vue'
import type { Context, DiagnosticRecord, Disposable } from '@lc/kernel'
import type {
  CanvasService,
  DocumentService,
  HistoryService,
  LoaderService,
  PluginManifest,
  WorkspaceService,
} from '@lc/contracts'
import { EventLog } from './core/feed'
import {
  buildCanvasView,
  buildConfigView,
  buildDependencies,
  collectPlugins,
  collectScopes,
  collectServices,
} from './core/snapshot'
import type {
  CanvasView,
  DependencyView,
  DevtoolsScope,
  EventLogEntry,
  PluginConfigView,
  PluginRow,
  ServiceRow,
} from './core/types'

/** devtools 的自省入口。 */
export interface DevtoolsSource {
  /** 应用根上下文；插件树、服务表、依赖图与事件日志都从它出发 */
  root: Context
  /**
   * 当前画布上下文。
   *
   * Realm 与画布层由 `ctx.fork()` 创建、不进 `Context.children`，从根树走不到，
   * 因此这一层只能由宿主告知。传 null 时画布面板为空态。
   */
  canvas?: Context | null
}

/** 顶栏摘要。 */
export interface DevtoolsSummary {
  /** 各状态实例数 */
  states: Record<PluginRow['state'], number>
  /** 插件实例总数 */
  plugins: number
  /** 服务条目总数 */
  services: number
  /** 事件日志条数 */
  events: number
  /** 诊断记录条数 */
  diagnostics: number
}

/** devtools 的只读状态与三个动作。 */
export interface DevtoolsState {
  /** 可自省的作用域层 */
  scopes: ComputedRef<DevtoolsScope[]>
  /** 插件树展平结果 */
  plugins: ComputedRef<PluginRow[]>
  /** 服务表 */
  services: ComputedRef<ServiceRow[]>
  /** 依赖边、阻塞点与等待环 */
  dependencies: ComputedRef<DependencyView>
  /** 事件日志，最新在前 */
  events: ComputedRef<readonly EventLogEntry[]>
  /** 内核诊断记录 */
  diagnostics: ComputedRef<readonly DiagnosticRecord[]>
  /** 画布快照 */
  canvasView: ComputedRef<CanvasView | null>
  /** 顶栏摘要 */
  summary: ComputedRef<DevtoolsSummary>
  /** 取某个实例的配置视图 */
  configOf(pluginId: string | null): PluginConfigView | null
  /** 重新排队一个卡住的实例 */
  retry(pluginId: string): void
  /** 卸载实例及其子树 */
  unload(pluginId: string): void
  /** 清空事件日志 */
  clearEvents(): void
}

/** 空的状态计数，保证摘要里的数字始终可比。 */
function emptyStates(): Record<PluginRow['state'], number> {
  return {
    loading: 0,
    pending: 0,
    applying: 0,
    active: 0,
    failed: 0,
    disposing: 0,
    disposed: 0,
  }
}

/**
 * 把多次触发合并成一次提交。
 *
 * 启动期连续 `provide` 会在同一轮里打出几十个事件，逐个自增版本会让整棵
 * computed 依赖树重复求值；合并成一次微任务后的自增仍然在同一帧可见。
 *
 * @param commit 微任务里真正执行的版本自增
 */
function createCoalescedBump(commit: () => void): () => void {
  let queued = false

  return (): void => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      commit()
    })
  }
}

/** 顶栏摘要：只做计数，不再读内核，保证与列表用的是同一批行数据。 */
function buildSummary(
  plugins: readonly PluginRow[],
  services: readonly ServiceRow[],
  events: readonly EventLogEntry[],
  diagnostics: readonly DiagnosticRecord[],
): DevtoolsSummary {
  const states = emptyStates()
  for (const row of plugins) states[row.state] += 1

  return {
    states,
    plugins: plugins.length,
    services: services.length,
    events: events.length,
    diagnostics: diagnostics.length,
  }
}

/**
 * 订阅画布侧的变化，统一收敛成一次画布快照重算。
 *
 * 视口、场景、覆盖层、选中集、文档、历史各有自己的 `onDidChange`，而快照是一次
 * 全量读取，因此不需要区分来源，任何一个通道都只负责触发重算。
 *
 * @param canvas 画布上下文
 * @param bumpCanvas 画布版本自增
 * @returns 待登记的订阅句柄；调用方负责在作用域销毁时释放
 */
function subscribeCanvasUpdates(canvas: Context, bumpCanvas: () => void): Disposable[] {
  const disposables: Disposable[] = []
  const view = canvas.get<CanvasService>('canvas')
  const document = canvas.get<DocumentService>('document')
  const history = canvas.get<HistoryService>('history')

  if (view) {
    disposables.push(view.viewport.onDidChange(bumpCanvas))
    disposables.push(view.scene.onDidChange(bumpCanvas))
    disposables.push(view.layers.onDidChange(bumpCanvas))
    disposables.push(view.selection.onDidChange(bumpCanvas))
  }
  if (document) disposables.push(document.onDidChange(bumpCanvas))
  if (history) disposables.push(history.onDidChange(bumpCanvas))

  return disposables
}

/**
 * 把内核的事件分发观测写进日志缓冲。
 *
 * 事件通道有独立的版本号：日志只驱动事件面板，不该连带重算插件树与依赖图。
 * 缓冲按 `EVENT_LOG_LIMIT` 封顶并淘汰最早的一条，因此高频手势（拖拽、框选）
 * 可以放开订阅而不积累内存。
 */
function subscribeEventLog(root: Context, log: EventLog, bumpEvents: () => void): Disposable {
  return root.bus.monitor((record) => {
    log.push(record)
    bumpEvents()
  })
}

/**
 * 建立 devtools 的响应式自省状态。
 *
 * 更新全部由内核事件驱动，没有轮询：插件状态与服务变化走 `internalBus` 与
 * `services` 观察器，事件日志走 `bus.monitor`，诊断走 `diagnostics.onChange`，
 * 画布走各服务自己的 `onDidChange`。
 *
 * 结构类变化合并到一次微任务：启动期连续 `provide` 会打出几十个事件，
 * 逐个重算整棵树和依赖图纯属浪费，而合并后仍然在同一帧内可见。
 *
 * 必须在组件 setup 里调用：所有订阅交给 `onScopeDispose` 回收。
 *
 * @param source 自省入口；上下文在调用时读取一次，宿主换 Realm 需要重挂面板
 */
export function useDevtools(source: DevtoolsSource): DevtoolsState {
  const revision = ref(0)
  const eventRevision = ref(0)
  const diagnosticRevision = ref(0)
  const canvasRevision = ref(0)
  const log = new EventLog()
  const disposables: Disposable[] = []

  const bump = createCoalescedBump(() => {
    revision.value += 1
  })

  const scopes = computed<DevtoolsScope[]>(() => {
    void revision.value
    return collectScopes(source.root, source.canvas ?? null)
  })

  const plugins = computed(() => {
    void revision.value
    return collectPlugins(scopes.value)
  })

  const services = computed(() => {
    void revision.value
    return collectServices(scopes.value)
  })

  // 清单变化不经过服务事件，跟着结构版本一起重读；没有 loader（纯内核场景）时为空
  const manifests = computed<readonly PluginManifest[]>(() => {
    void revision.value
    return source.root.get<LoaderService>('loader')?.scan() ?? []
  })

  const dependencies = computed(() =>
    buildDependencies(plugins.value, scopes.value, services.value, manifests.value),
  )

  const events = computed(() => {
    void eventRevision.value
    return log.list()
  })

  const diagnostics = computed(() => {
    void diagnosticRevision.value
    return source.root.diagnostics.list()
  })

  const canvasView = computed(() => {
    void canvasRevision.value
    return buildCanvasView(source.canvas ?? null)
  })

  const summary = computed<DevtoolsSummary>(() =>
    buildSummary(plugins.value, services.value, events.value, diagnostics.value),
  )

  disposables.push(source.root.internalBus.on('plugin', bump))
  disposables.push(source.root.services.onDidChange(bump))
  disposables.push(subscribeEventLog(source.root, log, () => (eventRevision.value += 1)))
  disposables.push(
    source.root.diagnostics.onChange(() => {
      diagnosticRevision.value += 1
    }),
  )

  // Realm 开关只影响作用域集合，不经过服务变化事件，需要单独订阅
  const workspace = source.root.get<WorkspaceService>('workspace')
  if (workspace) disposables.push(workspace.onDidChange(bump))

  const canvas = source.canvas ?? null
  if (canvas) {
    const bumpCanvas = (): void => {
      canvasRevision.value += 1
    }
    disposables.push(...subscribeCanvasUpdates(canvas, bumpCanvas))
  }

  onScopeDispose(() => {
    for (const disposable of disposables) disposable.dispose()
    disposables.length = 0
  })

  return {
    scopes,
    plugins,
    services,
    dependencies,
    events,
    diagnostics,
    canvasView,
    summary,
    configOf: (pluginId) => {
      if (!pluginId) return null
      void revision.value
      return buildConfigView(scopes.value, pluginId)
    },
    retry: (pluginId) => {
      source.root.runtime.retry(pluginId)
    },
    unload: (pluginId) => {
      source.root.runtime.unload(pluginId)
    },
    clearEvents: () => {
      log.clear()
      eventRevision.value += 1
    },
  }
}
