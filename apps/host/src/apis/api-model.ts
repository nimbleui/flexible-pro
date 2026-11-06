import type { ApiMethod, ProjectApi, ValueTypeSchema } from '@lc/schema'

/**
 * 项目接口的纯逻辑：表单输入归一化、localStorage 读档收窄、列表分组。
 *
 * 接口记录本身的结构定义在 `@lc/schema`（`ProjectApi`）：引用展开的纯函数要和它放在一起，
 * 设计器与运行态才能在不依赖宿主存储的前提下解析绑定。本文件只补宿主侧的读写形状，
 * 不读 localStorage、不碰浏览器 API，收窄与归一化留在这里才谈得上被 node 单测直接覆盖。
 */

/** 请求方法候选；顺序即编辑器下拉顺序，与 `ApiMethod` 全集一致 */
export const API_METHOD_OPTIONS: ReadonlyArray<{ value: ApiMethod; label: string }> = [
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'PATCH', label: 'PATCH' },
  { value: 'DELETE', label: 'DELETE' },
]

const API_METHOD_VALUES: readonly string[] = API_METHOD_OPTIONS.map((item) => item.value)

/** 新建或更新接口的输入；id 由存储层生成，时间戳也不在输入里 */
export interface ApiInput {
  /** 接口展示名；裁首尾空白，裁完为空即拒绝 */
  name: string
  /** 请求方法 */
  method: ApiMethod
  /** 请求路径；相对路径按项目前缀拼接，绝对 URL 原样使用 */
  path: string
  /** 分组名；空白串按未分组处理 */
  group?: string
  /** 说明；空白串按未填写处理 */
  description?: string
  /** 请求头；键为空的条目在归一化时被丢掉 */
  headers?: Record<string, string>
  /** query 参数默认值；同 `headers` 的清洗规则 */
  params?: Record<string, string>
  /** 请求体；由视图侧从 JSON 文本解析而来，这里不再判形状 */
  body?: unknown
  /** 跨域是否携带凭据；false 与缺省等价，不落库为 `false` */
  withCredentials?: boolean
  /** 期望响应格式；缺省按 json 处理 */
  responseType?: 'json' | 'text' | 'blob'
  /** 响应样本；由视图侧从 JSON 文本解析而来 */
  sample?: unknown
  /** 结果类型声明；空白类型节点由视图侧负责不收窄成 `{ kind: 'object' }` 之类的空壳 */
  resultType?: ValueTypeSchema
}

/** 归一化后可直接写进记录的可编辑字段 */
export type ApiEditableFields = Omit<ProjectApi, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>

/** 列表分组；`name` 为 null 表示未分组，恒定排在最后 */
export interface ApiGroup {
  /** 分组名 */
  name: string | null
  /** 组内接口，按修改时间倒序 */
  apis: ProjectApi[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

/**
 * 清洗键值对字段：键与值都裁掉首尾空白，空键直接丢掉。
 *
 * 请求头里留 `{ '': '' }` 会让实际请求带上一个空名字的头，而界面上看上去像是用户
 * 没填任何东西；空串值要保留，因为 `X-Trace-Id: ''` 是有意义的清空语义。
 *
 * @returns 清洗后的映射；全空时返回 `undefined`，让调用方写成缺省而不是空对象
 */
export function sanitizeEntries(
  map: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!map) return undefined

  const entries: Array<[string, string]> = []
  for (const [rawKey, rawValue] of Object.entries(map)) {
    const key = rawKey.trim()
    if (key === '') continue
    entries.push([key, rawValue?.trim() ?? ''])
  }

  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/**
 * 输入 → 可编辑字段。
 *
 * 集中做三件事：裁首尾空白、把「空白串 / 空集合」统一写成缺省、校验方法在候选集合内。
 * 名称与路径为空**不在这里抛错**：归一化只负责形状，能不能保存由存储层判定，
 * 否则视图要先判空再调用一次，同样的规则就写了两遍。
 *
 * @throws 方法不在 `ApiMethod` 集合内时抛错——那说明下拉与类型定义漂移了
 */
export function normalizeApiInput(input: ApiInput): ApiEditableFields {
  const name = input.name.trim()
  const path = input.path.trim()
  const group = input.group?.trim() ?? ''
  const description = input.description?.trim() ?? ''
  const headers = sanitizeEntries(input.headers)
  const params = sanitizeEntries(input.params)

  if (!API_METHOD_VALUES.includes(input.method)) {
    throw new Error(`[host] 不支持的请求方法: ${String(input.method)}`)
  }

  return {
    name,
    method: input.method,
    path,
    ...(group === '' ? {} : { group }),
    ...(description === '' ? {} : { description }),
    ...(headers === undefined ? {} : { headers }),
    ...(params === undefined ? {} : { params }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.withCredentials === true ? { withCredentials: true } : {}),
    ...(input.responseType === undefined || input.responseType === 'json'
      ? {}
      : { responseType: input.responseType }),
    ...(input.sample === undefined ? {} : { sample: input.sample }),
    ...(input.resultType === undefined ? {} : { resultType: input.resultType }),
  }
}

/**
 * 读档收窄：存储内容来自用户可编辑的 localStorage，逐字段判过才敢进列表。
 *
 * `name` 与 `path` 要求非空——没有名字的接口在列表里无法辨认，没有路径的接口点开就是
 * 一条必然失败的请求，两者都宁可丢掉这条记录。
 */
export function isProjectApi(value: unknown): value is ProjectApi {
  if (!isRecord(value)) return false

  return (
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.name === 'string' &&
    value.name !== '' &&
    typeof value.path === 'string' &&
    value.path !== '' &&
    typeof value.method === 'string' &&
    API_METHOD_VALUES.includes(value.method) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.group === undefined || typeof value.group === 'string') &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.projectId === undefined || typeof value.projectId === 'string') &&
    (value.headers === undefined || isStringMap(value.headers)) &&
    (value.params === undefined || isStringMap(value.params)) &&
    (value.withCredentials === undefined || typeof value.withCredentials === 'boolean') &&
    (value.responseType === undefined ||
      value.responseType === 'json' ||
      value.responseType === 'text' ||
      value.responseType === 'blob') &&
    (value.resultType === undefined || isRecord(value.resultType))
  )
}

/**
 * 列表分组。
 *
 * 按「出现过该分组名的顺序」而不是字典序排：接口登记是人工维护的，顺序本身就是作者的
 * 分类意图，字典序会把「订单」和「订单详情」拆到两处去。未分组恒在最后。
 *
 * @param apis 待分组的接口（已按项目过滤）
 * @returns 分组列表，组内按修改时间倒序
 */
export function groupApis(apis: readonly ProjectApi[]): ApiGroup[] {
  const groups: ApiGroup[] = []

  for (const api of apis) {
    const name = api.group?.trim() ?? ''
    const key = name === '' ? null : name
    const found = groups.find((group) => group.name === key)

    if (found) found.apis.push(api)
    else groups.push({ name: key, apis: [api] })
  }

  for (const group of groups) {
    group.apis.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  return groups.sort((a, b) => {
    if (a.name === null) return 1
    if (b.name === null) return -1

    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
}
