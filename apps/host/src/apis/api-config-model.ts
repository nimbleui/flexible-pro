import type { HttpRequestAuth, RequestDefaults, RequestEnvironment } from '@lc/schema'

/**
 * 项目请求环境（域名、默认头、默认参数、凭据策略）的纯逻辑。
 *
 * 一个项目可以同时存着「本地 / 测试 / 生产」三套配置，同一时刻只有一套生效：接口定义与页面
 * 文档都不记域名，切环境只改这一处，取数才可能跟着换域名。反过来，把域名写进每条接口就
 * 变成了 N 处要改的副本——那正是接口管理要解决的问题，不能在这里再犯一遍。
 *
 * 本文件不读 localStorage、不碰浏览器 API，读档收窄与归一化留在这里才能被 node 单测覆盖。
 */

/** 项目还没有配置过环境时的兜底那套：没有前缀、没有默认头，等于按相对路径原样请求 */
export const DEFAULT_ENVIRONMENT: RequestEnvironment = { id: 'default', name: '默认环境' }

/** 某个项目的请求环境集合 */
export interface ApiScopeConfig {
  /** 环境列表；顺序即下拉顺序，第一项是用户最先看到的那个 */
  environments: RequestEnvironment[]
  /** 当前生效的环境 id */
  activeEnvId: string
}

/** 新建或修改一套环境的输入 */
export interface EnvironmentInput {
  /** 目标环境 id；缺省表示新建 */
  id?: string
  /** 环境名；裁首尾空白，裁完为空即拒绝 */
  name: string
  /** 域名前缀；绝对地址或以 `/` 开头的路径，空白串按未配置处理 */
  baseUrl?: string
  /** 默认请求头，如 `Authorization` */
  headers?: Record<string, string>
  /** 默认查询参数 */
  params?: Record<string, string>
  /** 跨域是否携带凭据；false 与缺省等价 */
  withCredentials?: boolean
  /**
   * 凭据来源（可选）：登录接口的请求侧字段 + token 在响应里的路径。
   *
   * `request` 由面板从**项目已登记的接口**里选一条给出，而不是让使用者手抄一段 URL——
   * 登录接口本身就该被接口管理覆盖到（换域名、改路径、能调试）。
   */
  auth?: HttpRequestAuth
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

/**
 * 校验域名前缀的写法。
 *
 * 只接受绝对地址或以 `/` 开头的路径：`api.test/svc` 这种缺协议的写法会被浏览器当成
 * 当前页面下的相对路径，请求打到前端自己的地址上并返回 200 的 HTML——它比直接报错更难查。
 */
export function isUsableBaseUrl(baseUrl: string): boolean {
  const value = baseUrl.trim()
  if (value === '') return true

  return /^(?:[a-z][a-z\d+\-.]*:)?\/\//i.test(value) || value.startsWith('/')
}

/**
 * 输入 → 环境。
 *
 * @throws 名称为空、域名写法不合法时抛错，文案可直接展示给用户
 */
export function normalizeEnvironment(input: EnvironmentInput): RequestEnvironment {
  const name = input.name.trim()
  if (name === '') throw new Error('[host] 环境必须命名')

  const baseUrl = input.baseUrl?.trim() ?? ''
  if (!isUsableBaseUrl(baseUrl)) {
    throw new Error('[host] 域名需要是绝对地址（https://…）或以 / 开头的路径')
  }

  const headers =
    input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined
  const params = input.params && Object.keys(input.params).length > 0 ? input.params : undefined
  const auth = normalizeAuth(input.auth)

  return {
    id: input.id?.trim() || createEnvironmentId(),
    name,
    ...(baseUrl === '' ? {} : { baseUrl }),
    ...(headers === undefined ? {} : { headers }),
    ...(params === undefined ? {} : { params }),
    ...(input.withCredentials === true ? { withCredentials: true } : {}),
    ...(auth === undefined ? {} : { auth }),
  }
}

/**
 * 凭据来源归一化：没填路径就是「没配凭据」，填了一半即拒绝。
 *
 * 空 `tokenPath` 不能悄悄放过——那样每次请求都会带着一个空 token 出去，服务端报 401，
 * 而配置面板看起来像已经配好了一样。
 */
function normalizeAuth(auth: HttpRequestAuth | undefined): HttpRequestAuth | undefined {
  if (!auth) return undefined

  const path = auth.request.path.trim()
  const tokenPath = auth.tokenPath.trim()
  if (path === '') throw new Error('[host] 凭据来源需要选一个登录接口')
  if (tokenPath === '') throw new Error('[host] 凭据来源需要填写 token 在响应里的路径')

  const headerName = auth.headerName?.trim() ?? ''
  const valueTemplate = auth.valueTemplate?.trim() ?? ''

  return {
    request: { ...auth.request, path },
    ...(auth.sourceApiId === undefined ? {} : { sourceApiId: auth.sourceApiId }),
    tokenPath,
    ...(headerName === '' ? {} : { headerName }),
    ...(valueTemplate === '' ? {} : { valueTemplate }),
  }
}

/** 生成稳定 id；环境改名不影响引用它的项目配置 */
export function createEnvironmentId(): string {
  return `env-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 环境 → 请求默认值。
 *
 * 只取请求侧字段：`id` 与 `name` 是管理用的，不该混进发出去的请求配置里。
 */
export function toRequestDefaults(
  env: RequestEnvironment | undefined,
): RequestDefaults | undefined {
  if (!env) return undefined

  return {
    ...(env.baseUrl === undefined ? {} : { baseUrl: env.baseUrl }),
    ...(env.headers === undefined ? {} : { headers: env.headers }),
    ...(env.params === undefined ? {} : { params: env.params }),
    ...(env.withCredentials === undefined ? {} : { withCredentials: env.withCredentials }),
    ...(env.auth === undefined ? {} : { auth: env.auth }),
  }
}

/** 当前生效的环境；`activeEnvId` 指向不存在的环境时回落到第一项 */
export function activeEnvironment(config: ApiScopeConfig | undefined): RequestEnvironment {
  const environments = config?.environments ?? []
  if (environments.length === 0) return DEFAULT_ENVIRONMENT

  return environments.find((env) => env.id === config?.activeEnvId) ?? environments[0]!
}

/**
 * 凭据来源的读档收窄。
 *
 * 形状坏在这里判，而不是等 `fetchToken` 去猜：读档链是「归一化 → 存储 → 读档 → 运行时」，
 * 运行时抛错的现场离配置表最远，报出来的话术用户读不懂。坏一条就整条环境一起丢
 * （见 `isEnvironment`），宁可这次请求不带 token 而明明白白 401，也不要拿半个配置去发请求。
 */
function isAuth(value: unknown): value is HttpRequestAuth {
  if (!isRecord(value) || !isRecord(value.request)) return false

  return (
    typeof value.request.path === 'string' &&
    value.request.path !== '' &&
    typeof value.tokenPath === 'string' &&
    value.tokenPath !== '' &&
    (value.sourceApiId === undefined || typeof value.sourceApiId === 'string') &&
    (value.headerName === undefined || typeof value.headerName === 'string') &&
    (value.valueTemplate === undefined || typeof value.valueTemplate === 'string')
  )
}

/**
 * 读档收窄。
 *
 * 存储内容来自用户可编辑的 localStorage，逐字段判过才敢用。环境项坏一条丢一条而不是整条
 * 拒收：手改坏了一个环境就把整个项目的请求配置抹掉，会让用户看不见自己原本配好的域名。
 * `activeEnvId` 最后按剩下的环境校正，指针指向已丢弃环境时落到第一项。
 */
export function isEnvironment(value: unknown): value is RequestEnvironment {
  if (!isRecord(value)) return false

  return (
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.name === 'string' &&
    value.name !== '' &&
    (value.baseUrl === undefined ||
      (typeof value.baseUrl === 'string' && isUsableBaseUrl(value.baseUrl))) &&
    (value.headers === undefined || isStringMap(value.headers)) &&
    (value.params === undefined || isStringMap(value.params)) &&
    (value.withCredentials === undefined || typeof value.withCredentials === 'boolean') &&
    (value.auth === undefined || isAuth(value.auth))
  )
}

/** 读档收窄单个项目的环境集合；返回 `undefined` 表示这条记录不可用 */
export function narrowScopeConfig(value: unknown): ApiScopeConfig | undefined {
  if (!isRecord(value) || !Array.isArray(value.environments)) return undefined

  const environments = value.environments.filter(isEnvironment)
  if (environments.length === 0) return undefined
  // id 参与 activeEnvId 引用，重复条目会让同一个指针指向两套不同域名
  const seen = new Set<string>()
  const unique = environments.filter((env) => {
    if (seen.has(env.id)) return false
    seen.add(env.id)
    return true
  })

  const activeEnvId =
    typeof value.activeEnvId === 'string' && unique.some((env) => env.id === value.activeEnvId)
      ? value.activeEnvId
      : unique[0]!.id

  return { environments: unique, activeEnvId }
}
