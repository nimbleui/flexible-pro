import type { AxiosRequestConfig, AxiosResponse } from 'axios'

/**
 * 错误来源分层：`catch` 表示请求没有得到有效响应（网络、超时、配置错误），
 * `response` 表示服务端给出了响应但 HTTP 状态或业务 code 判定失败。
 */
export type RequestErrorType = 'catch' | 'response'

export interface RequestErrorOptions {
  /** 面向调用方的错误信息，来自 axios 消息、业务 code 或配置校验失败。 */
  message: string

  /** 错误来源分层，决定全局错误提示与埋点的归类。 */
  type: RequestErrorType

  /** 触发失败的 axios 配置，便于调用方排查具体请求。 */
  config?: AxiosRequestConfig

  /** 服务端响应；仅在 type 为 'response' 时存在，无有效响应时为 undefined。 */
  response?: AxiosResponse<unknown>

  /** 触发失败的业务 code（已转为字符串，兼容后端返回数字 code） */
  code?: string

  /** 是否命中 excludeCode，命中时只跳过全局错误回调 */
  isExclude?: boolean

  /** 原始异常，通过 Error 标准的 cause 字段保留，便于链式定位根因。 */
  cause?: unknown
}

/**
 * 请求层统一错误对象。保留原始 axios 响应与配置，便于调用方做细粒度恢复；
 * `isExclude` 让「可忽略错误」有明确的可判别标记，而不是靠解析错误文案。
 */
export class RequestError extends Error {
  readonly type: RequestErrorType

  readonly config?: AxiosRequestConfig

  readonly response?: AxiosResponse<unknown>

  readonly code?: string

  readonly isExclude: boolean

  /**
   * 由归一化的错误选项构造实例；cause 存在时透传给 Error 的 cause，保留原始异常链。
   *
   * @param options 错误来源、上下文与可忽略标记。
   */
  constructor(options: RequestErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause })

    this.name = 'RequestError'
    this.type = options.type
    this.config = options.config
    this.response = options.response
    this.code = options.code
    this.isExclude = options.isExclude ?? false
  }
}
