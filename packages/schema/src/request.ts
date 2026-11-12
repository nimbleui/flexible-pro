import { joinApiUrl } from './api'
import type { ApiRequestFields } from './api'
import type { RestConfig } from './datasource'

/**
 * 凭据怎么取。
 *
 * 登录接口是项目里登记的**一条普通接口**，而不是配置里手抄的一段 URL：token 的获取方式
 * 属于接口，就该和接口一起被管理、被环境拼接、被调试台验证。`request` 存的是请求侧字段，
 * 域名与前缀仍由同一套 `mergeRequestDefaults` 在发出前拼上。
 */
export interface HttpRequestAuth {
  /** 取凭据的接口（登录 / 换票） */
  request: ApiRequestFields
  /**
   * 来源接口的 id（可选）。
   *
   * 只用于配置面板回显「当初选的是哪条接口」，不参与请求。存在副本而不是每次都按 id 去查
   * 接口表，是为了版本定版与项目隔离：快照里的环境不该在运行时回查可能被改过的接口表，
   * 而一个 Realm 也不该去读别的项目的接口。代价是登录接口改了路径之后，环境里这份副本
   * 需要重新保存一次——面板会把路径显示出来，不至于看不见。
   */
  sourceApiId?: string
  /**
   * 响应里 token 的点路径，如 `data.accessToken`。
   *
   * 用路径而不是固定字段，是因为「响应包一层 `{ code, data }`」在服务端之间本来就不统一。
   */
  tokenPath: string
  /**
   * 注入的头名。
   *
   * @default 'Authorization'
   */
  headerName?: string
  /**
   * 值模板，`{token}` 是占位符。
   *
   * @default 'Bearer {token}'
   */
  valueTemplate?: string
}

/**
 * 项目级请求默认值：域名、默认头、默认参数、凭据策略。
 *
 * 放在 schema 层而不是宿主层，是因为一条 REST 请求有三个真实调用方——页面自写的数据源、
 * 项目接口展开出的条目、接口编辑器的调试台。规则只该有一份，否则「在调试台里通得了，
 * 放进页面就 401」这种差异没人能解释。这里只定义形状与合并算法，谁持有配置、
 * 存在哪里都属于宿主。
 */
export interface RequestDefaults {
  /** 请求前缀（域名）；相对地址按它拼接，绝对地址原样通过 */
  baseUrl?: string
  /**
   * 默认请求头，例如 `Authorization`。
   *
   * 请求自己写了同名头（大小写不敏感）时以请求为准——全局值是兜底，不是覆盖；
   * 需要强制统一注入时应该在接口定义里不要写这一项，而不是指望配置压过它。
   */
  headers?: Record<string, string>
  /** 默认查询参数，如同名的租户/时区参数；同名时以请求为准 */
  params?: Record<string, string>
  /** 跨域是否携带凭据；请求显式写过就以请求为准 */
  withCredentials?: boolean
  /** 凭据来源（可选）；配置后每次请求前取一次 token，命中 401 可重取并重发 */
  auth?: HttpRequestAuth
  /**
   * 401 时是否自动重取凭据并重发一次；缺省 true。
   *
   * 只在配置了 `auth` 时有意义；写成 false 用于「凭据失效就该如实报错」的调试场景。
   */
  autoRetry?: boolean
  /** 是否在控制台打印请求日志（方法 / 地址 / 状态 / 耗时）；缺省 false */
  requestLogging?: boolean
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === ''
}

/**
 * 一套请求环境：项目里可并存多份配置，同一时刻只有一套生效。
 *
 * `id` 稳定而 `name` 可改，发布快照记的是**当时那套环境本身**（不是 id）——环境可以被删掉
 * 或改地址，而「v3 跑在哪个域名上」必须是历史事实，靠 id 回查当前配置就等于让线上版本
 * 跟着草稿一起变。
 */
export interface RequestEnvironment extends RequestDefaults {
  /** 稳定 id；切换环境按它选 */
  id: string
  /** 环境展示名，如「本地」「测试」「生产」 */
  name: string
  /**
   * 登记的服务端响应头（可选），如网关应返回的 CORS 头。
   *
   * 设计期登记信息：随环境保存与发布快照导出，浏览器不会据此修改真实响应，
   * 因此不属于 `RequestDefaults`，也不会混进发出去的请求。
   */
  responseHeaders?: Record<string, string>
}

/**
 * 把项目默认值合并进一条 REST 配置。
 *
 * 三点约束：
 * 1. 局部优先——只有请求没有声明的键才补默认值，空键与空值按「没填」处理，
 *    免得界面上删掉一个头之后又被配置里的同名值偷偷塞回来；
 * 2. 请求头名大小写不敏感（HTTP 语义如此），查询参数大小写敏感；
 * 3. 输出字段顺序固定。取数服务用 `JSON.stringify({ type, config })` 当配置指纹来决定
 *    是否重置状态，合并结果每次必须得到同一个字符串，否则编辑无关字段会白重发一轮请求。
 *
 * @param config 请求自身的配置（来自页面数据源或项目接口展开）
 * @param defaults 项目默认值；`undefined` 或空对象时仍然返回一份字段序规整的副本
 * @returns 可直接交给 fetch 适配层的配置；不修改入参
 */
export function mergeRequestDefaults(
  config: RestConfig,
  defaults: RequestDefaults | undefined,
): RestConfig {
  const merged: RestConfig = {
    kind: 'rest',
    url: joinApiUrl(defaults?.baseUrl, config.url),
    method: config.method ?? 'GET',
  }

  const headers = mergeEntries(config.headers, defaults?.headers, true)
  const params = mergeEntries(config.params, defaults?.params, false)

  if (headers !== undefined) merged.headers = headers
  if (params !== undefined) merged.params = params
  if (config.body !== undefined) merged.body = config.body

  const credentials = config.withCredentials ?? defaults?.withCredentials
  if (credentials !== undefined) merged.withCredentials = credentials

  if (config.responseType !== undefined) merged.responseType = config.responseType

  return merged
}

/**
 * 把取到的 token 注入请求头。
 *
 * 两种情况原样返回：接口或默认头已经写了同名头（显式值是作者意图，运行时不该盖掉它）；
 * token 是空串（登录接口没返回东西）——宁可发一个不带该头的请求，让服务端报 401 或 400，
 * 也比发 `Bearer ` 这种半成品好诊断。
 *
 * @param config 已合并过默认值的请求配置
 * @param auth 凭据来源；头名与值模板都缺省成 `Authorization` / `Bearer {token}`
 * @param token 取到的凭据值
 * @returns 注入了头的配置；不需要注入时返回同一个引用
 */
export function withAuthHeader(
  config: RestConfig,
  auth: HttpRequestAuth,
  token: string,
): RestConfig {
  const headerName = auth.headerName?.trim() || 'Authorization'
  if (token.trim() === '') return config
  if (
    Object.keys(config.headers ?? {}).some(
      (key) => key.toLowerCase() === headerName.toLowerCase(),
    )
  ) {
    return config
  }

  const template = auth.valueTemplate?.trim() || 'Bearer {token}'

  return {
    ...config,
    headers: { ...config.headers, [headerName]: template.replace(/\{token\}/g, token) },
  }
}

/**
 * 合并两组键值对，局部优先。
 *
 * @param caseInsensitive 请求头名要忽略大小写，查询参数不要
 * @returns 全空时 `undefined`，让输出对象不留空键
 */
function mergeEntries(
  local: Record<string, string> | undefined,
  fallback: Record<string, string> | undefined,
  caseInsensitive: boolean,
): Record<string, string> | undefined {
  const result: Record<string, string> = {}
  const taken = new Set<string>()

  for (const [key, value] of Object.entries(local ?? {})) {
    if (isBlank(key)) continue
    result[key] = value
    taken.add(caseInsensitive ? key.toLowerCase() : key)
  }

  for (const [key, value] of Object.entries(fallback ?? {})) {
    if (isBlank(key)) continue
    if (taken.has(caseInsensitive ? key.toLowerCase() : key)) continue
    result[key] = value
  }

  return Object.keys(result).length === 0 ? undefined : result
}
