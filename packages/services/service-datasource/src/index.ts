import type { DataSourceService, DataSourceState, HttpService } from '@lc/contracts'
import { defineEditorPlugin } from '@lc/contracts'
import type {
  DataSourceSchemaDef,
  LocalStorageConfig,
  PageSchema,
  RequestDefaults,
  RestConfig,
} from '@lc/schema'
import { mergeRequestDefaults, resolveDataSourceValue } from '@lc/schema'
import { fetchRest } from './rest'

export { buildRestUrl, fetchRest } from './rest'
export type { RestRequestOptions } from './rest'

/** 插件配置：由宿主按当前项目与当前环境给出的请求默认值 */
interface DataSourceServiceConfig {
  /** 当前生效的请求默认值；来自宿主配置，可被 `setRequestDefaults` 覆盖 */
  requestDefaults?: RequestDefaults
}

interface Entry {
  /** 配置指纹；变化时重置状态并在 autoFetch 下重新请求 */
  fingerprint: string
  /**
   * 最近一次状态快照。
   *
   * 更新永远整体替换引用而非改写字段，`stateOf`/`states` 的读取方可以把
   * 对象引用变化直接当作重绘信号，不需要逐字段 diff。
   */
  state: DataSourceState
  /** 进行中的 REST 请求的中止控制器；同一时刻至多一个，完成或重置后清空 */
  controller?: AbortController
}

function fingerprintOf(source: DataSourceSchemaDef): string {
  return JSON.stringify({ type: source.type, config: source.config })
}

function restConfigOf(source: DataSourceSchemaDef): RestConfig | undefined {
  return source.type === 'rest' && source.config.kind === 'rest' ? source.config : undefined
}

function localStorageState(config: LocalStorageConfig): DataSourceState {
  try {
    if (typeof localStorage === 'undefined') {
      return { data: config.defaultValue, loading: false, loaded: true, error: null }
    }

    const raw = localStorage.getItem(config.key)
    if (raw === null) {
      return { data: config.defaultValue, loading: false, loaded: true, error: null }
    }

    try {
      return { data: JSON.parse(raw) as unknown, loading: false, loaded: true, error: null }
    } catch {
      return { data: raw, loading: false, loaded: true, error: null }
    }
  } catch (error) {
    return {
      data: undefined,
      loading: false,
      loaded: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 按声明生成初始状态；REST/GraphQL 等待 fetch，其余类型立即可用 */
function initialState(source: DataSourceSchemaDef): DataSourceState {
  if (source.type === 'mock' || source.type === 'static') {
    return { data: resolveDataSourceValue(source), loading: false, loaded: true, error: null }
  }

  if (source.type === 'localStorage' && source.config.kind === 'localStorage') {
    return localStorageState(source.config)
  }

  return { data: undefined, loading: false, loaded: false, error: null }
}

/**
 * 数据源运行时插件（Realm 级）。
 *
 * 状态属于文档 Realm：切换文档即换一套请求与状态。当前实现 REST 与本地数据源；
 * GraphQL、transform、cache、轮询尚未接入，未实现类型保持“未取数”状态。
 */
export default defineEditorPlugin<DataSourceServiceConfig>({
  name: 'service-datasource',
  inject: ['document'],

  schema: {
    // 原样带过：默认值的形状由宿主存储负责收窄，这里只可能收到「没有配置」这一种缺省
    parse: (input) => (input as DataSourceServiceConfig | undefined) ?? {},
  },

  apply(ctx, config) {
    const document = ctx.document
    /** 宿主的 HTTP 能力；没有提供时退回本包的 `fetchRest` */
    const http = ctx.get<HttpService>('http')
    /** 当前生效的请求默认值；`setRequestDefaults` 是唯一写入方 */
    let requestDefaults = config.requestDefaults
    const entries = new Map<string, Entry>()
    const listeners = new Set<() => void>()
    let disposed = false

    function notify(): void {
      for (const listener of [...listeners]) listener()
    }

    /** 自动取数的 rejection 不能变成全局 unhandledrejection，与显式 fetch 一样只记诊断 */
    function reportFetchError(error: unknown): void {
      ctx.diagnostics.report(error, { scope: 'dataSource', phase: 'autoFetch' })
    }

    function schema(): PageSchema {
      return document.model.schema
    }

    function findDefinition(id: string): DataSourceSchemaDef | undefined {
      return schema().datasources?.find((source) => source.id === id)
    }

    async function fetchState(id: string): Promise<void> {
      if (disposed) return

      const source = findDefinition(id)
      if (!source) return

      let entry = entries.get(id)
      if (!entry) {
        entry = { fingerprint: fingerprintOf(source), state: initialState(source) }
        entries.set(id, entry)
      }

      const config = restConfigOf(source)
      if (!config) {
        // 非 REST 源（mock/static/localStorage）立即可用：重新求值初始状态即可
        entry.state = initialState(source)
        notify()
        return
      }

      await runRestFetch(entry, config)
    }

    /**
     * 执行一次 REST 取数并回写状态。
     *
     * 先 abort 上一发在途请求，保证同一数据源任意时刻至多一个请求；回写前
     * 检查 abort 与 disposed，让「被顶掉的旧请求」迟到时不覆盖新结果。
     * finally 里比对 controller 引用后才清空，避免误清别处刚登记的新请求。
     */
    async function runRestFetch(entry: Entry, config: RestConfig): Promise<void> {
      const controller = new AbortController()
      try {
        // try 必须罩住整个函数体：前置的 notify() / 状态写入若抛错，绕过 finally 会让
        // controller 永远留在 entry 上、loading 永远停在 true。
        entry.controller?.abort()
        entry.controller = controller
        entry.state = { ...entry.state, loading: true, error: null }
        notify()

        // 默认值在这里合并：域名与 token 属于项目而不是文档，落进 schema 等于把凭证抄进
        // 每一篇导出的文档。有宿主 http 服务时交给它发（凭据注入与 401 重取只有一份实现），
        // 没有就退回裸取数，行为与引入这些能力之前一致。
        const merged = mergeRequestDefaults(config, requestDefaults)
        const data = http
          ? await http.request(merged, { signal: controller.signal, defaults: requestDefaults })
          : await fetchRest(merged, { signal: controller.signal })
        if (controller.signal.aborted || disposed) return
        entry.state = { data, loading: false, loaded: true, error: null }
      } catch (error) {
        if (controller.signal.aborted || disposed) return
        entry.state = {
          ...entry.state,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }
      } finally {
        if (entry.controller === controller) entry.controller = undefined
        notify()
      }
    }

    /** 按当前 schema 对齐状态表；只在数据源定义变化时重置/发起请求 */
    function sync(): void {
      if (disposed) return

      const sources = schema().datasources ?? []
      const seen = new Set<string>()
      let changed = false

      for (const source of sources) {
        seen.add(source.id)
        if (alignEntry(source)) changed = true
      }

      if (dropStaleEntries(seen)) changed = true

      if (changed) notify()
    }

    /**
     * 对齐单个数据源：新条目登记、配置指纹变化时中止在途请求并重置，
     * 两种情况都按需自动发起取数。
     *
     * @returns 状态表是否发生了变化，供 sync 决定是否广播
     */
    function alignEntry(source: DataSourceSchemaDef): boolean {
      const fingerprint = fingerprintOf(source)
      const existing = entries.get(source.id)

      if (!existing) {
        entries.set(source.id, { fingerprint, state: initialState(source) })
        if (shouldAutoFetch(source)) void fetchState(source.id).catch(reportFetchError)
        return true
      }

      if (existing.fingerprint === fingerprint) return false

      existing.controller?.abort()
      existing.controller = undefined
      existing.fingerprint = fingerprint
      existing.state = initialState(source)
      if (shouldAutoFetch(source)) void fetchState(source.id).catch(reportFetchError)
      return true
    }

    /** 只有 REST 源存在「取数」可言；autoFetch 显式为 false 时不自动请求 */
    function shouldAutoFetch(source: DataSourceSchemaDef): boolean {
      return restConfigOf(source) !== undefined && source.autoFetch !== false
    }

    /**
     * 清掉 schema 中已消失的条目及其在途请求。
     *
     * 删除数据源后若留着条目，`states()` 会继续吐出幽灵状态。
     */
    function dropStaleEntries(seen: Set<string>): boolean {
      let changed = false

      for (const [id, entry] of entries) {
        if (seen.has(id)) continue
        entry.controller?.abort()
        entries.delete(id)
        changed = true
      }

      return changed
    }

    /**
     * 换一套请求默认值并重取。
     *
     * 默认值不参与配置指纹，`sync()` 看不见它的变化，所以必须显式重发：切了环境却还显示
     * 上一个域名拿回来的数据，界面上没有任何线索，属于最难被发现的那类错。
     * 只重发 autoFetch 的 REST 源——显式关掉自动取数的源由用户自己点「刷新」触发。
     */
    function applyRequestDefaults(defaults: RequestDefaults | undefined): void {
      requestDefaults = defaults

      for (const source of schema().datasources ?? []) {
        if (restConfigOf(source) === undefined || !shouldAutoFetch(source)) continue
        void fetchState(source.id).catch(reportFetchError)
      }

      notify()
    }

    const service: DataSourceService = {
      stateOf: (id) => entries.get(id)?.state,
      states: () => Object.fromEntries([...entries].map(([id, entry]) => [id, entry.state])),
      fetch: fetchState,
      setRequestDefaults: applyRequestDefaults,
      onDidChange(listener) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
    }

    ctx.effect(() =>
      ctx.provide('dataSource', service, {
        apiVersion: '1.0',
      }),
    )
    ctx.effect(() => document.onDidChange(sync))
    ctx.effect(() => ({
      dispose: () => {
        disposed = true
        for (const entry of entries.values()) entry.controller?.abort()
        entries.clear()
        listeners.clear()
      },
    }))

    sync()
  },
})
