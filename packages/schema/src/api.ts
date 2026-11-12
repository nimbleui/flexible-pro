/**
 * 项目级接口（API）的数据形状与引用解析。
 *
 * 接口定义归属项目，页面只存一条绑定（绑定名 + 接口 id）。这解决的是「同一个接口在
 * 二十个页面里各存一份 URL」：改一次定义即处处生效，而运行时与表达式补全看到的仍然
 * 是完整的 `DataSourceSchemaDef` —— 引用在装载进文档时展开（`applyApiBindings`）、
 * 在写回存储时剥离（`stripApiBindings`），所以 `service-datasource`、`buildPageData`、
 * `buildPageSymbols` 都不必知道项目接口存在，也不需要新增一个跨作用域的服务。
 *
 * 本文件保持纯逻辑：不读 localStorage、不发请求、不依赖 Vue，与包内其他模块同一条约束。
 */

import type { DataSourceSchemaDef, RestConfig } from './datasource'
import type { ValueTypeSchema } from './functions'
import type { PageSchema } from './page'

/**
 * 接口请求方法。
 *
 * 与 `RestConfig.method` 同集合，单独命名是因为接口登记表与页面数据源是两处声明，
 * 取值范围必须只有一份定义。
 */
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

/** 参数登记的类型候选；只是设计期登记信息，不参与请求序列化 */
export type ApiParamType = 'string' | 'number' | 'boolean'

/**
 * 一条 query 参数的登记信息（设计期元数据）。
 *
 * 与 `params` 的默认值分开存：默认值参与请求，类型 / 必填 / 说明只服务协作与补全提示，
 * 运行时不据此做校验或转换。
 */
export interface ApiParamMeta {
  /** 参数类型；缺省按 string 展示 */
  type?: ApiParamType
  /** 是否必填；缺省 false */
  required?: boolean
  /** 说明 */
  description?: string
}

/**
 * 项目里登记的一条接口。
 *
 * 只描述「怎么发这个请求」与「回来的数据长什么样」，不含页面侧的行为：自动取数、
 * 轮询、转换管道都跟着页面走，写在 `DataSourceSchemaDef` 上。
 */
export interface ProjectApi {
  /** 稳定 id；页面绑定引用它，改名不影响它 */
  id: string
  /** 归属项目 id；缺省表示默认项目 */
  projectId?: string
  /** 接口展示名，列表与补全详情用 */
  name: string
  /** 分组名（可选），列表按它折叠；一个字符串，不是目录树 */
  group?: string
  /** 说明（可选），展示在列表副标题与补全详情里 */
  description?: string
  /** 标签（可选）；自由标记，供列表搜索与筛选，不影响请求 */
  tags?: string[]
  /**
   * 是否公开（可选，缺省 false）。
   *
   * 登记信息：标记接口是否面向项目外公开，随定义保存与导出；运行时不据此做权限拦截。
   */
  isPublic?: boolean
  /** 请求方法 */
  method: ApiMethod
  /**
   * 请求路径。
   *
   * 存的就是登记进来的原样路径：相对路径在**发出请求时**按当前环境的域名前缀拼接
   * （`mergeRequestDefaults`），已经是绝对 URL 或协议相对地址时不拼——登记第三方接口时
   * 不该被迫跟着本项目的环境走。
   */
  path: string
  /** 请求头，键值对 */
  headers?: Record<string, string>
  /** query 参数默认值，键值对；页面数据源里的同名参数由请求侧合并 */
  params?: Record<string, string>
  /**
   * 参数登记信息（可选），键与 `params` 对应。
   *
   * 只服务设计期：类型 / 必填 / 说明供协作与补全提示，请求仍按 `params` 的默认值发送。
   */
  paramMeta?: Record<string, ApiParamMeta>
  /** 请求体（POST / PUT / PATCH 用），纯 JSON 结构 */
  body?: unknown
  /** 跨域请求是否携带凭据 */
  withCredentials?: boolean
  /**
   * 期望的响应格式。
   *
   * @default 'json'
   */
  responseType?: 'json' | 'text' | 'blob'
  /**
   * 响应样本（可选）。
   *
   * 与 `DataSourceSchemaDef.sample` 同义：只服务设计期补全与类型推导，运行时不当作数据。
   */
  sample?: unknown
  /** 结果类型声明（可选），缺省时由样本推导 */
  resultType?: ValueTypeSchema
  /** 创建时间（ISO 字符串） */
  createdAt: string
  /** 最后修改时间（ISO 字符串） */
  updatedAt: string
}

/**
 * 页面里的一条接口绑定。
 *
 * `id` 是页面侧的绑定名（结果挂在 `data.<id>`），与 `apiId` 指向的接口名互相独立：
 * 接口改名不影响页面表达式，页面想换个绑定名也不影响其他页面。
 */
export interface PageApiBinding {
  /** 页面内绑定名，同时是 `data` 下的键 */
  id: string
  /** 被引用的项目接口 id */
  apiId: string
  /**
   * 是否随页面初始化自动取数。
   *
   * @default true
   */
  autoFetch?: boolean
}

/** 绝对 URL 或协议相对地址（`//host/path`）；命中即不拼前缀 */
const ABSOLUTE_URL_PATTERN = /^(?:[a-z][a-z\d+\-.]*:)?\/\//i

/**
 * 拼接项目前缀与接口路径。
 *
 * 存在这一处纯拼接，而不是让每个请求方各写一遍 `base + path`：斜杠数量与「路径本身
 * 就是绝对 URL」这两种边界散在外层迟早出现两种拼法，而拼错的结果是请求打到错误域名，
 * 在界面上看不出来。
 *
 * @param baseUrl 项目前缀；空白串按未配置处理
 * @param path 接口路径；空串返回空串，交给调用方判定为无效地址
 * @returns 可直接交给 `buildRestUrl` 的地址
 */
export function joinApiUrl(baseUrl: string | undefined, path: string): string {
  const trimmedPath = path.trim()
  if (trimmedPath === '') return ''

  const prefix = baseUrl?.trim() ?? ''
  if (prefix === '' || ABSOLUTE_URL_PATTERN.test(trimmedPath)) return trimmedPath

  return `${prefix.replace(/\/+$/, '')}/${trimmedPath.replace(/^\/+/, '')}`
}

/**
 * 接口定义里真正参与请求的那几个字段。
 *
 * 单独命名是因为「一条接口定义怎么变成一份 REST 配置」这件事有三个调用方：绑定展开、
 * 发布快照、以及接口编辑器对**未保存草稿**发调试请求。后两个手上没有完整的 `ProjectApi`
 * （草稿还没有 id 与时间戳），共用这个子集就不必为它们编造字段，也不会出现第二套映射。
 */
export type ApiRequestFields = Pick<
  ProjectApi,
  'method' | 'path' | 'headers' | 'params' | 'body' | 'withCredentials' | 'responseType'
>

/**
 * 接口定义 → REST 数据源配置。
 *
 * `url` 存的就是登记的路径，**不在此拼项目域名**：域名属于环境而不属于接口定义，页面自写的
 * 数据源同样要按环境拼地址，两处各拼一次会出现 `https://a/https://a/...` 这种叠加。唯一的
 * 拼接点是请求发出前的 `mergeRequestDefaults`。
 *
 * 字段按固定顺序写入：`service-datasource` 用 `JSON.stringify({ type, config })` 作为
 * 配置指纹来决定是否重置取数状态，同一份定义每次展开出的字符串必须一致，否则编辑
 * 无关字段会让页面重新发一轮请求。
 *
 * @param api 接口定义
 * @returns 与页面手配的 REST 数据源无法区分的配置对象
 */
export function apiToRestConfig(api: ApiRequestFields): RestConfig {
  const headers =
    api.headers && Object.keys(api.headers).length > 0 ? { ...api.headers } : undefined
  const params =
    api.params && Object.keys(api.params).length > 0 ? { ...api.params } : undefined

  return {
    kind: 'rest',
    url: api.path,
    method: api.method,
    ...(headers === undefined ? {} : { headers }),
    ...(params === undefined ? {} : { params }),
    ...(api.body === undefined ? {} : { body: api.body }),
    ...(api.withCredentials === undefined ? {} : { withCredentials: api.withCredentials }),
    ...(api.responseType === undefined ? {} : { responseType: api.responseType }),
  }
}

/**
 * 取出一条接口定义里参与请求的那几个字段。
 *
 * 存在的理由只有一个：把整条 `ProjectApi` 塞进别处（比如环境的凭据来源）会连带把名称、
 * 分组、时间戳一起复制一份，而那份副本没人维护也没人看得见。字段清单在这里定义一次，
 * 复制出去的就只是请求侧。
 */
export function apiRequestFieldsOf(api: ProjectApi): ApiRequestFields {
  return {
    method: api.method,
    path: api.path,
    ...(api.headers === undefined ? {} : { headers: { ...api.headers } }),
    ...(api.params === undefined ? {} : { params: { ...api.params } }),
    ...(api.body === undefined ? {} : { body: api.body }),
    ...(api.withCredentials === undefined ? {} : { withCredentials: api.withCredentials }),
    ...(api.responseType === undefined ? {} : { responseType: api.responseType }),
  }
}

/**
 * 一条绑定展开成页面数据源声明。
 *
 * 绑定名与结果类型都按 `DataSourceSchemaDef` 的既有语义写，展开产物与页面手配的数据源
 * 同形，因此下游（取数、补全、`buildPageData`）不需要分支判断来源。
 *
 * @param binding 页面绑定
 * @param apis 该项目名下的接口表；接口不存在时返回 `undefined`，由调用方决定怎么提示悬空引用
 * @returns 可直接放进 `PageSchema.datasources` 的声明
 */
export function resolveApiBinding(
  binding: PageApiBinding,
  apis: readonly ProjectApi[],
): DataSourceSchemaDef | undefined {
  const api = apis.find((item) => item.id === binding.apiId)
  if (!api) return undefined

  const description = api.description?.trim() ?? ''
  const autoFetch = binding.autoFetch !== false

  return {
    id: binding.id,
    type: 'rest',
    ...(description === '' ? {} : { description }),
    ...(api.sample === undefined ? {} : { sample: api.sample }),
    ...(api.resultType === undefined ? {} : { resultType: api.resultType }),
    config: apiToRestConfig(api),
    autoFetch,
  }
}

/**
 * 把绑定展开进 `schema.datasources`，得到装载进文档时该用的 schema。
 *
 * 规则是「`id` 出现在 `apis` 里，它就属于绑定」：同名条目原位替换、新条目追加在末尾，
 * 与 `stripApiBindings` 的剥离口径完全一致，读写两端不会各有一套理解。重名会连带替换
 * 页面自有数据源，所以建立绑定前必须用 `findBindingIdConflicts` 挡住。
 *
 * @param schema 存储里的页面文档
 * @param apis 该项目名下的接口表
 * @returns 没有绑定或与入参完全一致时返回同一个引用，否则返回替换过 `datasources` 的副本
 */
export function applyApiBindings(schema: PageSchema, apis: readonly ProjectApi[]): PageSchema {
  const bindings = schema.apis
  if (!bindings || bindings.length === 0) return schema

  const resolved: DataSourceSchemaDef[] = []
  for (const binding of bindings) {
    const source = resolveApiBinding(binding, apis)
    if (source) resolved.push(source)
  }

  // 全部引用都悬空时保持原样，避免为了一个空展开结果重建整棵 schema
  if (resolved.length === 0) return schema

  const locals = schema.datasources ?? []
  const merged = locals.map(
    (source) => resolved.find((item) => item.id === source.id) ?? source,
  )
  merged.push(...resolved.filter((source) => !locals.some((item) => item.id === source.id)))

  return { ...schema, datasources: merged }
}

/**
 * 写回存储前剥离来自绑定的条目。
 *
 * 展开结果绝不能落盘：一旦把解析出的 URL 写进 `datasources`，页面就退化成了自带副本，
 * 「改一次处处生效」静默失效，而界面上没有任何痕迹。剥离只认 `apis` 里声明过的绑定名，
 * 因此不需要在条目上额外挂来源标记。
 *
 * @param schema 文档内存态
 * @returns 与入参同形但 `datasources` 只剩页面自有条目的副本；无需剥离时返回同一个引用
 */
export function stripApiBindings(schema: PageSchema): PageSchema {
  const bindings = schema.apis
  if (!bindings || bindings.length === 0) return schema

  const boundIds = new Set(bindings.map((binding) => binding.id))
  const locals = (schema.datasources ?? []).filter((source) => !boundIds.has(source.id))

  if (locals.length === (schema.datasources?.length ?? 0)) return schema

  // 没有自有数据源时写成 undefined：JSON 序列化会丢掉这个键，存储里不留 `datasources: []`
  return locals.length === 0
    ? { ...schema, datasources: undefined }
    : { ...schema, datasources: locals }
}

/**
 * 找出指向不存在接口的绑定。
 *
 * 悬空引用不能让请求静默失败：接口被删掉之后，页面表达式里的 `data.<id>` 会一直是
 * 未取数状态，用户看不出原因。列表与绑定选择器都读这里，判断只写一遍。
 *
 * @param bindings 页面绑定列表
 * @param apis 该项目名下的接口表
 * @returns 无法解析的绑定，顺序与入参一致
 */
export function findUnresolvedBindings(
  bindings: readonly PageApiBinding[],
  apis: readonly ProjectApi[],
): PageApiBinding[] {
  const known = new Set(apis.map((api) => api.id))

  return bindings.filter((binding) => !known.has(binding.apiId))
}

/**
 * 找出与页面自有数据源重名的绑定。
 *
 * 绑定与自有条目共用 `data` 命名空间，重名的后果是自有条目被绑定顶掉并在写回时消失，
 * 所以要在建立绑定当场拦住，而不是让用户发现少了一个数据源。
 *
 * @param schema 页面文档
 * @returns 冲突的绑定名，顺序稳定
 */
export function findBindingIdConflicts(schema: PageSchema): string[] {
  const bindings = schema.apis
  const locals = schema.datasources
  if (!bindings || !locals) return []

  const localIds = new Set(locals.map((source) => source.id))

  return bindings.map((binding) => binding.id).filter((id) => localIds.has(id))
}
