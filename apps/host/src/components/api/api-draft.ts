import type { ApiInput } from '../../apis/api-model'
import type {
  ApiMethod,
  ApiParamMeta,
  ApiParamType,
  ProjectApi,
  ValueTypeSchema,
} from '@lc/schema'
import { formatJsonValue, parseJsonDraft } from '@lc/shared'

/**
 * 接口编辑器的表单草稿与提交值之间的映射。
 *
 * 单独成模块而不是留在组件里，是因为「草稿文本 → 可提交输入」这一步带 JSON 解析与
 * 键值对清洗：写错的后果是静默丢掉请求头或把非法 JSON 存进接口定义，这类边界必须能在
 * node 环境里直接跑，而不必先起浏览器。
 *
 * 草稿用平铺的字符串字段而不是 `ApiInput`：输入框要绑 `string`，数字与嵌套对象在表单里
 * 一律先按文本承载，提交时才解析。
 */

/** 一行键值对；请求头与 query 参数都用它 */
export interface ApiKeyValueRow {
  /** 名字；首尾空白在提交时裁掉，空键的行会被丢掉 */
  key: string
  /** 值；空串有意义（清空一个头），不会被丢 */
  value: string
}

/** 一行 query 参数：默认值之外带设计期登记信息（类型 / 必填 / 说明） */
export interface ApiParamRow extends ApiKeyValueRow {
  /** 参数类型；缺省 string */
  type: ApiParamType
  /** 是否必填 */
  required: boolean
  /** 说明 */
  description: string
}

/** 接口编辑器的完整草稿态 */
export interface ApiDraft {
  /** 接口展示名 */
  name: string
  /** 分组名 */
  group: string
  /** 说明 */
  description: string
  /** 标签 */
  tags: string[]
  /** 是否公开 */
  isPublic: boolean
  /** 请求方法 */
  method: ApiMethod
  /** 请求路径 */
  path: string
  /** 请求头行 */
  headers: ApiKeyValueRow[]
  /** query 参数行（含登记信息） */
  params: ApiParamRow[]
  /** 请求体 JSON 文本；空串表示不带 body */
  bodyText: string
  /** 响应样本 JSON 文本；空串表示没有样本 */
  sampleText: string
  /** 跨域是否携带凭据 */
  withCredentials: boolean
  /** 期望响应格式 */
  responseType: 'json' | 'text' | 'blob'
}

/** 草稿提交结果 */
export interface ApiDraftParse {
  /** 校验通过时可提交的输入；失败为 `undefined` */
  input?: ApiInput
  /** 可直接展示的失败文案；空串表示通过 */
  error: string
}

/** 新建接口的初始草稿：GET + 空路径，勾选与响应格式都按运行时的缺省 */
export function createApiDraft(): ApiDraft {
  return {
    name: '',
    group: '',
    description: '',
    tags: [],
    isPublic: false,
    method: 'GET',
    path: '',
    headers: [{ key: '', value: '' }],
    params: [createParamRow()],
    bodyText: '',
    sampleText: '',
    withCredentials: false,
    responseType: 'json',
  }
}

/** 一行空参数：类型按 string、非必填，与登记信息的缺省一致 */
export function createParamRow(): ApiParamRow {
  return { key: '', value: '', type: 'string', required: false, description: '' }
}

/**
 * 接口定义 → 草稿。
 *
 * 缺省字段一律展开成表单的初始值而不是留空，否则「没填 over」与「填了又清空」两种状态
 * 在界面上无法区分，保存时会把用户没碰过的字段写成缺省值。
 */
export function draftFromApi(api: ProjectApi): ApiDraft {
  return {
    name: api.name,
    group: api.group ?? '',
    description: api.description ?? '',
    tags: [...(api.tags ?? [])],
    isPublic: api.isPublic === true,
    method: api.method,
    path: api.path,
    headers: mapToRows(api.headers),
    params: paramRowsFrom(api.params, api.paramMeta),
    bodyText: formatJsonValue(api.body),
    sampleText: formatJsonValue(api.sample),
    withCredentials: api.withCredentials === true,
    responseType: api.responseType ?? 'json',
  }
}

/**
 * 参数默认值 + 登记信息 → 参数行。
 *
 * 空映射给一行空行，与请求头同一取舍：让第一次填参数的人看见这里能填。
 */
export function paramRowsFrom(
  params: Record<string, string> | undefined,
  meta: Record<string, ApiParamMeta> | undefined,
): ApiParamRow[] {
  const entries = Object.entries(params ?? {}).map(([key, value]): ApiParamRow => {
    const info = meta?.[key]

    return {
      key,
      value,
      type: info?.type ?? 'string',
      required: info?.required === true,
      description: info?.description ?? '',
    }
  })

  return entries.length === 0 ? [createParamRow()] : entries
}

/**
 * 参数行 → 默认值映射 + 登记信息。
 *
 * 空键的行丢掉；登记信息只在该行确有非缺省内容时才写，且键与默认值映射保持一致，
 * 不会留下指向已删参数的孤儿登记。
 */
export function rowsToParams(rows: readonly ApiParamRow[]): {
  params: Record<string, string> | undefined
  paramMeta: Record<string, ApiParamMeta> | undefined
} {
  const params: Array<[string, string]> = []
  const meta: Record<string, ApiParamMeta> = {}

  for (const row of rows) {
    const key = row.key.trim()
    if (key === '') continue
    params.push([key, row.value])

    const description = row.description.trim()
    if (row.type === 'string' && !row.required && description === '') continue
    meta[key] = {
      ...(row.type === 'string' ? {} : { type: row.type }),
      ...(row.required ? { required: true } : {}),
      ...(description === '' ? {} : { description }),
    }
  }

  return {
    params: params.length === 0 ? undefined : Object.fromEntries(params),
    paramMeta: Object.keys(meta).length === 0 ? undefined : meta,
  }
}

/**
 * 映射 → 键值行。
 *
 * 空映射给一行空行：让第一次填头的人看见这里能填，而不是先点「添加」。
 */
export function mapToRows(map: Record<string, string> | undefined): ApiKeyValueRow[] {
  const entries = Object.entries(map ?? {}).map(([key, value]) => ({ key, value }))

  return entries.length === 0 ? [{ key: '', value: '' }] : entries
}

/**
 * 键值行 → 映射。
 *
 * 空键的行直接丢掉（界面上「加了一行没填」不等于要发一个空名字的头）；同名后者胜出，
 * 与 `Object.fromEntries` 一致，不做大小写归一——请求头名的大小写本就不该由登记表规定。
 *
 * @returns 一行有效数据都没有时返回 `undefined`，让存储写成缺省而不是 `{}`
 */
export function rowsToMap(rows: readonly ApiKeyValueRow[]): Record<string, string> | undefined {
  const entries: Array<[string, string]> = []

  for (const row of rows) {
    const key = row.key.trim()
    if (key === '') continue
    entries.push([key, row.value])
  }

  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/**
 * 草稿 → 可提交输入，顺带做表单侧校验。
 *
 * 校验只判「这份草稿能不能变成一条合法定义」：JSON 文本先解析，解析失败连字段都不产出，
 * 免得半截 JSON 存进接口后让运行时炸在别处。名称与路径为空的判断同时存在于存储层，
 * 这里先判是为了把错误显示在表单上而不是抛给用户一个异常。
 *
 * @param draft 当前草稿
 * @param resultType 结构化类型编辑器算出的结果类型；缺省表示这条定义不声明类型，由样本推导
 * @returns 通过时 `error` 为空串并带 `input`；失败时 `error` 可直接展示
 */
export function parseApiDraft(draft: ApiDraft, resultType?: ValueTypeSchema): ApiDraftParse {
  const name = draft.name.trim()
  if (name === '') return { error: '接口必须命名' }

  const path = draft.path.trim()
  if (path === '') return { error: '接口必须填写请求路径' }

  const body = parseJsonDraft(draft.bodyText)
  if (!body.ok) return { error: `请求体：${body.error}` }

  const sample = parseJsonDraft(draft.sampleText)
  if (!sample.ok) return { error: `响应样本：${sample.error}` }

  const { params, paramMeta } = rowsToParams(draft.params)

  return {
    error: '',
    input: {
      name,
      method: draft.method,
      path,
      group: draft.group,
      description: draft.description,
      tags: draft.tags,
      isPublic: draft.isPublic,
      headers: rowsToMap(draft.headers),
      params,
      paramMeta,
      body: body.value,
      sample: sample.value,
      withCredentials: draft.withCredentials,
      responseType: draft.responseType,
      ...(resultType === undefined ? {} : { resultType }),
    },
  }
}
