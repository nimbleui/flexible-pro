import type { Disposable } from '@lc/kernel'

/**
 * 单个数据源的运行时状态。
 *
 * 表达式通过 `data.<id>` 访问它：结果在 `.data`，请求状态在
 * `.loading / .loaded / .error`。把结果与状态放在同一个对象里，
 * 是为了让表达式不必额外记住另一套命名。
 */
export interface DataSourceState {
  /** 成功取到的结果；未取数或失败时保持上一次成功值（首次为 undefined） */
  readonly data: unknown
  /** 是否正在请求 */
  readonly loading: boolean
  /** 是否至少成功加载过一次 */
  readonly loaded: boolean
  /** 错误信息；无错误时为 null */
  readonly error: string | null
}

/**
 * 数据源运行时服务（Realm 级）。
 *
 * 只负责按 schema 声明取数与维护状态；数据的表达式访问由渲染层组装。
 * 请求失败写入 state 而不是 reject `fetch`，避免每个刷新按钮都要写 catch。
 */
export interface DataSourceService {
  /** 取单个数据源状态；未声明的 id 返回 undefined */
  stateOf(id: string): DataSourceState | undefined
  /** 当前全部数据源状态快照 */
  states(): Readonly<Record<string, DataSourceState>>
  /**
   * 主动取数。
   *
   * REST 数据源会发起请求并更新 loading/error/loaded；Mock/静态数据源直接重算状态。
   * 请求失败只写入 state，不会 reject，因此调用方可以安全地 `void service.fetch(id)`。
   */
  fetch(id: string): Promise<void>
  /** 任一数据源状态变化时通知；订阅方自行按 id 比对 */
  onDidChange(listener: () => void): Disposable
}
