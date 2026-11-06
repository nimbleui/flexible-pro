import type { RestConfig } from '@lc/schema'

/** REST 取数选项；fetchImpl 只用于测试注入 */
export interface RestRequestOptions {
  /**
   * 注入的 fetch 实现，缺省取 `globalThis.fetch`。
   *
   * 仅供单元测试替换网络层；生产调用方不应传入，否则绕开环境一致性检查。
   */
  fetchImpl?: typeof fetch
  /**
   * 中止信号。
   *
   * 服务层用数据源自有的 AbortController 驱动它：abort 后 fetch 以 AbortError
   * 拒绝，调用方据此丢弃迟到结果。
   */
  signal?: AbortSignal
}

/**
 * 把 `params` 拼到 URL 上。
 *
 * 不依赖 URL 构造器：低代码里的地址常是 `/api/users` 这样的相对路径，
 * 用 `new URL` 需要一个无意义的 base，反而多一层出错点。
 */
export function buildRestUrl(config: RestConfig): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(config.params ?? {})) {
    params.append(key, value)
  }

  const query = params.toString()
  if (query === '') return config.url

  return `${config.url}${config.url.includes('?') ? '&' : '?'}${query}`
}

function requestBody(config: RestConfig, headers: Headers): string | undefined {
  if (config.body === undefined) return undefined
  if (config.method === undefined || config.method === 'GET') return undefined

  const body = typeof config.body === 'string' ? config.body : JSON.stringify(config.body)

  if (body !== undefined && !headers.has('content-type')) {
    headers.set('Content-Type', 'application/json')
  }

  return body
}

function readResponse(response: Response, config: RestConfig): Promise<unknown> {
  const responseType = config.responseType ?? 'json'

  if (responseType === 'text') return response.text()
  if (responseType === 'blob') return response.blob()

  return response.text().then((text) => {
    if (text.trim() === '') return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      // 带上方法与实际地址：域名配错时服务端常返回 200 的 HTML，只说「不是合法 JSON」
      // 使用者无从知道请求打到了哪里——而配错前缀正是这个项目级默认值最容易犯的错
      throw new Error(`响应不是合法 JSON（${config.method ?? 'GET'} ${buildRestUrl(config)}）`)
    }
  })
}

/**
 * 执行一次 REST 请求。
 *
 * 只负责“配置 → HTTP → 结果”，不读写 dataSource 状态；状态机留在服务插件里，
 * 这样请求逻辑可以脱离内核单独测试。
 *
 * @throws HTTP 非 2xx、JSON 解析失败、fetch 本身失败时抛错
 */
export async function fetchRest(
  config: RestConfig,
  options: RestRequestOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (!fetchImpl) throw new Error('当前运行环境不支持 fetch')

  const method = config.method ?? 'GET'
  const headers = new Headers(config.headers)
  const response = await fetchImpl(buildRestUrl(config), {
    method,
    headers,
    body: requestBody(config, headers),
    credentials: config.withCredentials ? 'include' : 'same-origin',
    signal: options.signal,
  })

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
    )
  }

  return readResponse(response, config)
}
