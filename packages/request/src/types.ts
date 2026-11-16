import type { AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios'

import type { RequestError, RequestErrorType } from './errors'

/**
 * 配置值既可以写死，也可以写成「根据本次调用的 baseData 动态计算」的函数。
 * 函数会被原样调用一次，因此不要在函数里做有副作用的重复计算。
 */
export type FunTypeMixin<X, B> = X | ((baseData: B) => X)

/** 格式化后的数据：保留原类型并允许附加字段。 */
export type FormattedData<T> = T & Record<string, unknown>

/** axios 的 params 原类型是 any，这里收紧成普通对象以保证配置侧类型可推导。 */
export type RequestParams = Record<string, unknown>

/**
 * 实例级拦截器。在 axios 实例上注册，对经过该实例的所有请求生效，
 * 用于注入 token、统一日志、401 刷新等横切逻辑。
 *
 * 这里只约束签名，实际注册交给 axios，因此错误拦截器返回值可自行决定重试或继续 reject。
 */
export interface RequestInterceptors {
  /** 请求发出前修改配置，典型用途是注入 Authorization。 */
  request?: (
    config: InternalAxiosRequestConfig,
  ) => InternalAxiosRequestConfig | Promise<InternalAxiosRequestConfig>

  /** 请求拦截器抛错时的处理，返回值会继续向下传递，抛错则中断。 */
  requestError?: (error: unknown) => unknown | Promise<unknown>

  /** 响应到达后、本封装解析前执行，可用于预处理原始响应。 */
  response?: (response: AxiosResponse) => AxiosResponse | Promise<AxiosResponse>

  /** 响应错误（含 HTTP 非 2xx）处理，可恢复返回值或继续 reject。 */
  responseError?: (error: unknown) => unknown | Promise<unknown>
}

/**
 * 单次请求配置。T 是响应数据类型，D 是请求体类型，B 是动态输入类型。
 *
 * 除下列字段外，其余字段原样透传给 axios（headers、timeout、signal 等）。
 */
export interface RequestConfigType<
  T = unknown,
  D = Record<string, unknown>,
  B = unknown,
  N extends string = string,
> extends Omit<AxiosRequestConfig, 'method' | 'data'> {
  /** 请求路径 */
  url: string

  /** 请求体；函数形式接收本次调用的 baseData */
  data?: FunTypeMixin<D, B>

  /** 查询参数；函数形式接收本次调用的 baseData */
  params?: FunTypeMixin<RequestParams, B>

  /** 请求方法；函数形式接收本次调用的 baseData */
  method?: FunTypeMixin<AxiosRequestConfig['method'], B>

  /**
   * 真正发请求前的钩子。返回 false 终止请求，此时 Promise 解析为 undefined。
   *
   * 收到的是已经解析完 data/params/method/baseURL 的 axios 配置。
   */
  before?: (options: { config: AxiosRequestConfig; data?: D; baseData?: B }) => void | boolean

  /** 对解包后的业务数据做格式化，返回值就是 Promise 的最终结果 */
  format?: (data: T) => FormattedData<T>

  /**
   * 成功回调。`data` 是解包并格式化后的业务数据，`ret` 是未解包的完整响应体。
   * `ret` 的类型沿用 T（与 dataPath=false 时一致）；dataPath 为点路径时其真实形态是响应信封，
   * 需要精确信封类型时应另行声明泛型，不要在回调里把 ret 当成 data 使用。
   * 回调仅用于副作用，不改变 Promise 的结果。
   */
  success?: (data: FormattedData<T>, ret: T) => void

  /**
   * 失败回调。HTTP 无有效响应时为 'catch'，服务端响应判定失败时为 'response'。
   * 回调后 Promise 仍会 reject，不会吞掉错误。
   */
  error?: (error: RequestError, errType: RequestErrorType) => void

  /**
   * 业务数据路径，支持点语法（如 `data.list`）。
   *
   * - 默认 `'data'`
   * - `false` 表示返回完整响应体
   * - `true` 与默认值等价
   */
  dataPath?: string | boolean

  /**
   * 哪些业务 code 算成功；未配置时用 `'0'` 与 `'200'`。
   * 响应中没有 code 字段时一律视为成功。
   */
  includeCode?: string | string[]

  /**
   * 业务 code 判定失败且命中此列表时，错误对象带 `isExclude: true`，
   * 请求级 error 回调仍会执行，但全局 onError 不会执行。
   */
  excludeCode?: string | string[]

  /** code 所在的路径，支持点语法；默认 `code` */
  codePath?: string

  /**
   * 域名别名，是实例级 `baseURLs` 的键，用于取对应 baseURL。
   * 类型 N 由 createRequest/createApis 从 `baseURLs` 的键推导，写错会在编译期报错。
   */
  netType?: N
}

/**
 * 实例级默认配置。只放与「实例」相关的能力，单请求配置请写在 RequestConfigType 中。
 *
 * N 是 `baseURLs` 的键集合，会从传入的 `baseURLs` 字面量自动推导，
 * 并约束本实例所有 netType 的取值。
 */
export interface RequestDefaults<B = unknown, N extends string = string> {
  /** 传给 axios.create 的配置 */
  axiosConfig?: AxiosRequestConfig

  /** 实例级拦截器，对所有经由此实例发出的请求生效 */
  interceptors?: RequestInterceptors

  /** 域名别名到 baseURL 的映射；其键即合法的 netType 取值，不在实现里硬编码域名 */
  baseURLs?: Record<N, string>

  /** 实例默认域名别名；单次请求的 netType 可覆盖，取值受 N 约束 */
  netType?: N

  /** 实例默认数据路径 */
  dataPath?: string | boolean

  /** 实例默认 code 路径 */
  codePath?: string

  /** 实例默认成功 code 列表 */
  includeCode?: string | string[]

  /** 实例默认可忽略 code 列表 */
  excludeCode?: string | string[]

  /** 全局错误回调；`isExclude` 为 true 的错误不会触发它 */
  onError?: (error: RequestError, errType: RequestErrorType) => void
}

/** request 的函数签名。B 与 N 由 createRequest 锁定，T/D 可在单次调用时指定或推导。 */
export interface RequestFunction<B = unknown, N extends string = string> {
  <T = unknown, D = Record<string, unknown>>(
    config: RequestConfigType<T, D, B, N>,
    baseData?: B,
  ): Promise<FormattedData<T> | undefined>
}

/**
 * API 配置映射：方法名到请求配置的映射。
 *
 * 每一项可以有各自的 T/D/B，TS 无法用单一类型参数表达这种异构映射，
 * 因此这里用 any 承载；调用侧通过 satisfies 保留的精确类型由 ApiMethods 还原。
 * N 约束所有配置项的 netType 必须是实例 baseURLs 的键。
 */
export type ApiConfigMap<N extends string = string> = Record<
  string,
  RequestConfigType<any, any, any, N>
>

/**
 * 由配置映射推导出的可调用方法集合。
 *
 * 每个方法的入参取自对应配置的 B（动态函数的 baseData），返回值取自 T。
 * 用 `satisfies ApiConfigMap` 声明配置，才能让这里的推导落到具体类型而非 any。
 */
export type ApiMethods<M extends ApiConfigMap> = {
  [K in keyof M]: M[K] extends RequestConfigType<infer T, any, infer B>
    ? (baseData?: B) => Promise<FormattedData<T> | undefined>
    : never
}
