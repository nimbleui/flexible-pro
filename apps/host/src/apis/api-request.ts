import type { ApiRequestFields, RequestDefaults, RestConfig } from '@lc/schema'
import { apiToRestConfig, getAtPath, mergeRequestDefaults, withAuthHeader } from '@lc/schema'
import type { HttpService } from '@lc/contracts'

/**
 * 接口调试台与宿主 HTTP 服务共用的请求传输。
 *
 * 配置语义与运行时的 REST 数据源**共用同一个函数**（`mergeRequestDefaults`），所以不存在
 * 「调试通过、放进页面就 401」这类由两套规则造成的差异。剩下的差别只有一处刻意的：本模块
 * 的结果**不抛异常**——调试台要把状态码、响应头、耗时与失败原因一起显示出来。
 * `HttpService` 把它包成抛异常的形状，因为取数服务的状态机就是按抛错设计的。
 */

/** 一次调试请求的结果；`ok` 只表示 2xx，失败细节在 `error` */
export interface ApiRequestResult {
  /** 请求是否成功发出并拿到 2xx 响应 */
  ok: boolean
  /** HTTP 状态码；请求根本没发出去时为 0 */
  status: number
  /** 状态文本 */
  statusText: string
  /** 实际请求的完整地址（已拼域名与 query） */
  url: string
  /** 响应头；只保留可以直接展示的字符串值 */
  headers: Record<string, string>
  /** 按 `responseType` 解析出的响应体；解析失败时为原始文本 */
  body: unknown
  /** 响应不是合法 JSON 时的原始文本，便于看出「返回的是 HTML 错误页」这类问题 */
  rawText?: string
  /** 端到端耗时（毫秒），包含网络往返与响应体读取 */
  durationMs: number
  /** 失败原因；`ok` 为 true 时缺省 */
  error?: string
  /** 这次请求注入的凭据头名；用于说明「带了 token 仍然 401」和「没带 token」的区别 */
  authHeader?: string
}

/** 请求执行的可注入项 */
export interface ApiRequestOptions {
  /** 取消信号；调试台「重新发送」前先中止上一次在途请求 */
  signal?: AbortSignal
  /** 注入 fetch 供单测使用；缺省走 `globalThis.fetch` */
  fetchImpl?: typeof fetch
}

/** 没有请求体的方法：带上 body 会被部分服务端判成非法请求 */
const BODYLESS_METHODS: readonly string[] = ['GET', 'HEAD']

/**
 * 已取到的凭据缓存。
 *
 * 键里带**合并后的登录地址**：换环境等于换登录域名，旧 token 不该跟着过去。
 * 它是模块级的，因为一次页面加载里十几个数据源共用同一个登录接口——不去重的话，
 * 每次 token 过期都会把登录接口打一遍 N 次。
 */
const tokenCache = new Map<string, string>()
/** 同一时刻只允许一次取票在途；并发请求等同它，而不是各自去登录 */
let pendingToken: { key: string; promise: Promise<string> } | undefined

/**
 * 把 query 参数并进地址。
 *
 * 不整体交给 `new URL`：接口允许写相对路径（`/api/users`），构造绝对 URL 会强制要求
 * base，而开发期本来就是靠同源相对路径发请求的。已有查询串时用 `&` 续接。
 */
function withQuery(url: string, params: Record<string, string> | undefined): string {
  if (!params) return url

  const entries = Object.entries(params)
  if (entries.length === 0) return url

  const query = new URLSearchParams(entries).toString()

  return `${url}${url.includes('?') ? '&' : '?'}${query}`
}

function headerRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = value
  })

  return result
}

/**
 * 将要请求的完整地址，供发送前肉眼核对。
 *
 * 与 `sendApiRequest` 共用 `resolveRequest`，所以这里显示的就是真正发出去的那个。
 * 注意它不含凭据头：token 是发送时才注入的，显示在地址栏里既没意义也会泄露。
 */
export function previewRequestUrl(
  spec: ApiRequestFields,
  defaults: RequestDefaults | undefined,
): string {
  return resolveRequest(spec, defaults).url
}

/** 草稿 + 项目默认值 → 实际要发的地址与配置 */
function resolveRequest(
  spec: ApiRequestFields,
  defaults: RequestDefaults | undefined,
): { url: string; config: RestConfig } {
  const config = mergeRequestDefaults(apiToRestConfig(spec), defaults)

  return { url: withQuery(config.url, config.params), config }
}

/**
 * 按点路径从响应里取字段。
 *
 * 平台里「从一份数据里取字段」用的是点路径（与数据源的 `PathTransform.path` 一致，如
 * `data.items`），而 `getAtPath` 吃 JSON Pointer，所以在这里转换一次。已经写成 `/a/b`
 * 的也认，不要求使用者记住两套。
 */
function pickByPath(body: unknown, path: string): unknown {
  const pointer = path.startsWith('/')
    ? path
    : `/${path
        .split('.')
        .filter((part) => part !== '')
        .join('/')}`

  return getAtPath(body, pointer)
}

/** 取一次凭据：走同一个传输层，所以登录接口也享受域名拼接与错误处理 */
async function fetchToken(
  defaults: RequestDefaults,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const auth = defaults.auth
  if (!auth) throw new Error('[host] 未配置凭据来源')

  const login = resolveRequest(auth.request, defaults)
  const key = login.url
  const cached = tokenCache.get(key)
  if (cached !== undefined) return cached

  // 并发只刷一次：第二个调用者等同一个在途请求，而不是再去登录一遍
  if (pendingToken && pendingToken.key === key) return pendingToken.promise

  const promise = (async () => {
    const result = await sendRequest(login.config, { url: login.url }, { signal, fetchImpl })
    if (!result.ok) {
      throw new Error(`登录接口取凭据失败：${result.error ?? `HTTP ${result.status}`}`)
    }

    const token = pickByPath(result.body, auth.tokenPath)
    if (typeof token !== 'string' || token === '') {
      throw new Error(`登录接口响应里 ${auth.tokenPath} 不是可用的字符串凭据`)
    }

    tokenCache.set(key, token)

    return token
  })().finally(() => {
    if (pendingToken?.key === key) pendingToken = undefined
  })

  pendingToken = { key, promise }

  return promise
}

/**
 * 发一次已经合并过默认值的请求。
 *
 * 带 `defaults.auth` 时会先取凭据、注入请求头；命中 401 就丢掉缓存重取一次并重发——
 * **只重发一次**，否则凭据始终无效的请求会在服务端与客户端之间无限打转。
 *
 * @param config 完整请求配置
 * @param defaults 项目默认值；凭据来源从这里的 `auth` 读，登录接口也按这里拼域名
 * @param options 取消信号与 fetch 注入
 * @returns 完整的调试结果；任何失败都编码进返回值，不抛出
 */
export async function sendRequest(
  config: RestConfig,
  located: { url: string },
  options: ApiRequestOptions & { defaults?: RequestDefaults } = {},
): Promise<ApiRequestResult> {
  const startedAt = Date.now()
  const elapsed = (): number => Date.now() - startedAt
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const empty: ApiRequestResult = {
    ok: false,
    status: 0,
    statusText: '',
    url: located.url,
    headers: {},
    body: undefined,
    durationMs: 0,
  }

  if (located.url === '') return { ...empty, error: '接口没有填写请求路径' }

  const auth = options.defaults?.auth
  const defaults = options.defaults
  let sent = config
  let authHeader: string | undefined

  if (defaults && auth) {
    try {
      const token = await fetchToken(defaults, options.signal, fetchImpl)
      sent = withAuthHeader(config, auth, token)
      authHeader = auth.headerName?.trim() || 'Authorization'
    } catch (error) {
      // 取不到凭据也要发出一次诊断：让它直接失败会把「登录接口挂了」和「业务接口挂了」混在一起
      return {
        ...empty,
        durationMs: elapsed(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const first = await perform(sent, located.url, options.signal, fetchImpl, startedAt)

  // 401 只处理一次：丢缓存 → 重新取票 → 重发。第二次再 401 就如实报失败，否则凭据
  // 一直无效的请求会在服务端与客户端之间无限打转。
  if (defaults && auth && first.status === 401) {
    tokenCache.delete(resolveRequest(auth.request, defaults).url)
    try {
      const token = await fetchToken(defaults, options.signal, fetchImpl)
      const retry = await perform(
        withAuthHeader(config, auth, token),
        located.url,
        options.signal,
        fetchImpl,
        startedAt,
      )

      return { ...retry, authHeader }
    } catch (error) {
      // 重取凭据本身失败：仍然把第一次的 401 结果交出去，只把新原因并进文案
      const reason = error instanceof Error ? error.message : String(error)

      return { ...first, error: `${first.error ?? 'HTTP 401'}；重新取凭据失败：${reason}` }
    }
  }

  return authHeader === undefined ? first : { ...first, authHeader }
}

/** 真正的一次 fetch：把失败编码进结果而不是抛出，供上层选择怎么处理 */
async function perform(
  config: RestConfig,
  url: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
  startedAt: number,
): Promise<ApiRequestResult> {
  const elapsed = (): number => Date.now() - startedAt
  const headers = { ...config.headers }
  const method = config.method ?? 'GET'
  const hasBody = config.body !== undefined && !BODYLESS_METHODS.includes(method)
  if (hasBody && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json'
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(config.body) } : {}),
      credentials: config.withCredentials ? 'include' : 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError'
    const reason = error instanceof Error ? error.message : String(error)

    return {
      ok: false,
      status: 0,
      statusText: '',
      url,
      headers: {},
      body: undefined,
      durationMs: elapsed(),
      error: aborted ? '已取消' : `请求失败：${reason}（跨域目标需要允许 CORS）`,
    }
  }

  const base: ApiRequestResult = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url,
    headers: headerRecord(response.headers),
    body: undefined,
    durationMs: elapsed(),
  }
  const failure = response.ok
    ? undefined
    : `HTTP ${response.status} ${response.statusText}`.trim()

  if (config.responseType === 'blob') {
    const blob = await response.blob()

    return {
      ...base,
      durationMs: elapsed(),
      error: failure,
      body: { type: blob.type, size: blob.size },
    }
  }

  const text = await response.text()
  if (config.responseType === 'text') {
    return { ...base, durationMs: elapsed(), error: failure, body: text }
  }

  try {
    return {
      ...base,
      durationMs: elapsed(),
      error: failure,
      body: text === '' ? undefined : JSON.parse(text),
    }
  } catch {
    // JSON 解析失败要连着原文一起回：只说「不是合法 JSON」看不出返回的是登录页还是网关错误
    return {
      ...base,
      durationMs: elapsed(),
      error: failure ?? '响应不是合法 JSON',
      body: undefined,
      rawText: text,
    }
  }
}

/**
 * 按接口定义（或表单草稿）发一次请求。
 *
 * @param spec 请求侧字段
 * @param defaults 当前生效的请求默认值；域名、默认头与凭据来源都由它给出
 * @param options 取消信号与 fetch 注入
 */
export async function sendApiRequest(
  spec: ApiRequestFields,
  defaults: RequestDefaults | undefined,
  options: ApiRequestOptions = {},
): Promise<ApiRequestResult> {
  const { url, config } = resolveRequest(spec, defaults)

  return sendRequest(config, { url }, { ...options, defaults })
}

/**
 * 宿主提供的 `http` 服务实现。
 *
 * 与调试台共用 `sendRequest`，所以运行时与调试台的凭据行为逐字一致；本层只多做一件事：
 * 把结果对象翻译成抛异常，交给取数服务的状态机去写 `error`。
 */
export const httpService: HttpService = {
  async request(config, options) {
    const defaults = options?.defaults
    const { url } = splitUrl(config)
    const result = await sendRequest(config, { url }, { signal: options?.signal, defaults })
    if (!result.ok)
      throw new Error(result.error ?? `HTTP ${result.status} ${result.statusText}`.trim())

    return result.body
  },
  dropTokens() {
    tokenCache.clear()
    pendingToken = undefined
  },
}

/** 从配置算出实际请求地址，好让 `perform` 与结果里的 `url` 保持一致 */
function splitUrl(config: RestConfig): { url: string } {
  return { url: withQuery(config.url, config.params) }
}
