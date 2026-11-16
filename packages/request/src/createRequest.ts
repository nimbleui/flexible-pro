import axios from 'axios'
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'

import { RequestError } from './errors'
import type {
  FormattedData,
  RequestConfigType,
  RequestDefaults,
  RequestFunction,
} from './types'
import { getValueByPath, resolveMixin, toCodeList } from './utils'

const DEFAULT_DATA_PATH = 'data'
const DEFAULT_CODE_PATH = 'code'
const DEFAULT_SUCCESS_CODES: readonly string[] = ['0', '200']

// 这些字段属于本封装，不能原样传给 axios。
const CUSTOM_CONFIG_KEYS = new Set([
  'data',
  'params',
  'method',
  'before',
  'format',
  'success',
  'error',
  'dataPath',
  'includeCode',
  'excludeCode',
  'codePath',
  'netType',
])

interface PreparedRequest<D> {
  aborted: boolean

  axiosConfig: AxiosRequestConfig

  data?: D
}

/**
 * 创建带统一默认配置、域名映射与错误语义的请求函数。
 *
 * B 在工厂层锁定，因此 `data`/`params`/`method` 的动态函数参数始终有明确类型；
 * N 从 `baseURLs` 的键推导，约束所有 netType 的取值；
 * T/D 在单次调用时通过泛型参数或配置推导。返回的 Promise：
 *
 * - 成功：解析为解包并格式化后的数据
 * - `before` 返回 false：解析为 undefined
 * - 失败：reject 为 RequestError，且先执行请求级与全局错误回调
 *
 * 回调中的异常会原样向外抛出，不会被本封装吞掉。
 *
 * @param defaults 实例级默认配置：axios 基础配置、netType 域名映射、code 规则与全局错误回调。
 * @returns 遵循上述成功/终止/失败约定的 request 函数。
 */
export function createRequest<B = unknown, N extends string = string>(
  defaults: RequestDefaults<B, N> = {},
): RequestFunction<B, N> {
  const instance: AxiosInstance = axios.create(defaults.axiosConfig)

  // 拦截器注册在实例上，而非每次请求；这样 token 注入、401 刷新等横切逻辑只配置一次。
  // use 同时接收成功与失败处理，失败分支的返回值决定错误是被恢复还是继续抛出。
  const interceptors = defaults.interceptors

  if (interceptors?.request || interceptors?.requestError) {
    instance.interceptors.request.use(interceptors.request, interceptors.requestError)
  }

  if (interceptors?.response || interceptors?.responseError) {
    instance.interceptors.response.use(interceptors.response, interceptors.responseError)
  }

  /**
   * 把本封装的配置拆成 axios 可识别的配置，并解析动态值。
   *
   * 显式配置优先于 netType 映射：单次请求的 baseURL > netType > 实例 axiosConfig。
   * 自定义字段必须先剔除，否则会被当成 axios 原生配置透传而污染请求。
   *
   * @param config 单次请求配置。
   * @param baseData 本次调用的动态输入，用于解析 data/params/method 的函数形式。
   * @param data 已解析的请求体；单独写入而非走遍历，因为它是从 FunTypeMixin 中提取出来的。
   * @returns 交给 axios 的最终配置。
   * @throws netType 未配置对应 baseURL 时抛出 RequestError（type 为 catch）。
   */
  function buildAxiosConfig<T, D>(
    config: RequestConfigType<T, D, B, N>,
    baseData: B | undefined,
    data: D | undefined,
  ): AxiosRequestConfig {
    const axiosConfig: AxiosRequestConfig = { ...defaults.axiosConfig }

    for (const [key, value] of Object.entries(config)) {
      if (CUSTOM_CONFIG_KEYS.has(key)) continue

      Object.assign(axiosConfig, { [key]: value })
    }

    const params = resolveMixin(config.params, baseData)
    const method = resolveMixin(config.method, baseData)

    if (params !== undefined) axiosConfig.params = params
    if (method !== undefined) axiosConfig.method = method
    if (data !== undefined) axiosConfig.data = data

    const netType = config.netType ?? defaults.netType

    if (netType !== undefined && config.baseURL === undefined) {
      const baseURL = defaults.baseURLs?.[netType]

      if (baseURL === undefined) {
        throw new RequestError({
          message: `未配置 netType "${netType}" 对应的 baseURL`,
          type: 'catch',
        })
      }

      axiosConfig.baseURL = baseURL
    }

    return axiosConfig
  }

  /**
   * 按点路径读取业务 code 并统一转成字符串。
   *
   * 后端可能返回数字 code，而 includeCode/excludeCode 是字符串，
   * 这里统一 String 化，避免 `200` 与 `'200'` 比较失败；null/undefined 视为无 code。
   *
   * @param source 响应数据（未解包的完整响应体）。
   * @param codePath code 所在的点路径。
   * @returns 字符串形式的 code；字段缺失时为 undefined。
   */
  function readCode(source: unknown, codePath: string): string | undefined {
    const code = getValueByPath(source, codePath)

    return code === undefined || code === null ? undefined : String(code)
  }

  /**
   * 把任意来源的异常归一成 RequestError。
   *
   * 上层只需处理一种错误形状：已有的 RequestError 原样返回；
   * AxiosError 按有无 response 区分 catch/response，并从响应体补出 code 与 isExclude；
   * 其余异常一律归到 catch 层。
   *
   * @param error 原始异常，可能来自 before、配置解析、网络或 axios 拦截器。
   * @param codePath 从 AxiosError 响应体读取 code 的点路径。
   * @param excludeCodes 可忽略 code 列表，用于标记 isExclude。
   * @returns 统一的 RequestError；传入值本身是 RequestError 时原样返回。
   */
  function toRequestError(
    error: unknown,
    codePath: string,
    excludeCodes: string[] | undefined,
  ): RequestError {
    if (error instanceof RequestError) return error

    if (axios.isAxiosError(error)) {
      const response = error.response
      const code = response?.data === undefined ? undefined : readCode(response.data, codePath)

      return new RequestError({
        message: error.message,
        type: response ? 'response' : 'catch',
        config: error.config,
        response,
        code,
        isExclude: code !== undefined && (excludeCodes?.includes(code) ?? false),
        cause: error,
      })
    }

    return new RequestError({
      message: error instanceof Error ? error.message : String(error),
      type: 'catch',
      cause: error,
    })
  }

  /**
   * 执行错误回调。请求级 error 总会触发；全局 onError 仅在非 exclude 时触发。
   *
   * excludeCode 表达的是「不打扰全局提示」，但调用方仍可能想在请求级自行处理，
   * 因此这里保留请求级回调、只跳过全局回调。注意：本函数会调用外部传入的回调（有副作用）。
   *
   * @param config 单次请求配置，提供请求级 error 回调。
   * @param error 已归一的错误对象。
   */
  function notifyError<T, D>(config: RequestConfigType<T, D, B, N>, error: RequestError): void {
    config.error?.(error, error.type)

    // excludeCode 的语义是「不打扰全局提示」，但请求级回调必须保留，调用方仍能自行处理。
    if (!error.isExclude) defaults.onError?.(error, error.type)
  }

  /**
   * 解析动态配置、执行 before 钩子，产出交给 axios 的配置。
   *
   * 准备阶段（含 netType 解析、before 自身）抛出的异常会被归一为 RequestError，
   * 先通知错误回调再抛出，避免这部分错误绕过统一的错误语义。
   *
   * @param config 单次请求配置。
   * @param baseData 本次调用的动态输入。
   * @param codePath 用于错误归一的 code 读取路径。
   * @param excludeCodes 用于错误归一的 exclude 列表。
   * @returns 带 aborted 标记的准备结果；aborted 为 true 时调用方应跳过请求。
   * @throws 准备阶段任一失败都会抛出 RequestError。
   */
  function prepare<T, D>(
    config: RequestConfigType<T, D, B, N>,
    baseData: B | undefined,
    codePath: string,
    excludeCodes: string[] | undefined,
  ): PreparedRequest<D> {
    try {
      const data = resolveMixin(config.data, baseData)
      const axiosConfig = buildAxiosConfig(config, baseData, data)

      if (config.before?.({ config: axiosConfig, data, baseData }) === false) {
        return { aborted: true, axiosConfig, data }
      }

      return { aborted: false, axiosConfig, data }
    } catch (error) {
      const requestError = toRequestError(error, codePath, excludeCodes)

      notifyError(config, requestError)
      throw requestError
    }
  }

  /**
   * 执行一次请求：判定业务 code → 按 dataPath 解包 → format → success → 返回。
   *
   * 阶段顺序是隐式契约：code 判定发生在解包之前（code 位于信封层），
   * format 发生在 success 之前（回调拿到的是格式化后的值）。
   * 失败时先通知错误回调再 reject，不会吞掉错误。
   *
   * @param config 单次请求配置。
   * @param baseData 本次调用的动态输入，传给 data/params/method 的函数形式。
   * @returns 解包并格式化后的业务数据；before 返回 false 时为 undefined。
   * @throws 网络/HTTP/业务 code 失败时 reject RequestError；回调自身抛错时原样传播。
   */
  const request = async <T = unknown, D = Record<string, unknown>>(
    config: RequestConfigType<T, D, B, N>,
    baseData?: B,
  ): Promise<FormattedData<T> | undefined> => {
    const codePath = config.codePath ?? defaults.codePath ?? DEFAULT_CODE_PATH
    const includeCodes = toCodeList(config.includeCode ?? defaults.includeCode)
    const excludeCodes = toCodeList(config.excludeCode ?? defaults.excludeCode)

    const prepared = prepare(config, baseData, codePath, excludeCodes)

    if (prepared.aborted) return undefined

    const axiosConfig = prepared.axiosConfig

    const response = await instance.request<unknown>(axiosConfig).catch((error: unknown) => {
      const requestError = toRequestError(error, codePath, excludeCodes)

      notifyError(config, requestError)
      throw requestError
    })

    // axios 的 data 是 unknown，T 由调用方声明，这是网络边界上唯一必要的断言。
    const ret = response.data as T
    const code = readCode(response.data, codePath)

    if (code !== undefined && !(includeCodes ?? DEFAULT_SUCCESS_CODES).includes(code)) {
      const requestError = new RequestError({
        message: `请求失败，code=${code}`,
        type: 'response',
        config: axiosConfig,
        response,
        code,
        isExclude: excludeCodes?.includes(code) ?? false,
      })

      notifyError(config, requestError)
      throw requestError
    }

    const dataPath =
      config.dataPath === undefined ? (defaults.dataPath ?? DEFAULT_DATA_PATH) : config.dataPath
    // true 与默认值等价，先归一成 false | string 再决定是否需要解包。
    const path = dataPath === true ? DEFAULT_DATA_PATH : dataPath
    const unpacked = path === false ? ret : getValueByPath(ret, path)
    const formatted = config.format
      ? config.format(unpacked as T)
      : (unpacked as FormattedData<T>)

    config.success?.(formatted, ret)

    return formatted
  }

  return request
}
