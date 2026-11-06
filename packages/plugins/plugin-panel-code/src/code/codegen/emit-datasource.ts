import type { DataSourceSchemaDef, TransformConfig } from '@lc/schema'
import type { CodegenContext } from './context'
import { warn } from './context'
import { emitExpression } from './emit-expression'
import { emitJsonLiteral, fetchFunctionName, memberKey, quote } from './naming'

/** 数据源出码结果：状态初值 + 取数函数 + 挂载时要不要自动取数 */
export interface EmittedSource {
  id: string
  /** `sources` 里的一条初值 */
  initial: string
  /** 取数函数源码；mock / static 没有取数过程，返回空数组 */
  fetch: string[]
  /** 页面挂载后是否自动取数 */
  autoFetch: boolean
  /** 轮询间隔（毫秒）；0 表示不轮询 */
  pollingMs: number
}

/** 点路径形态的 sort.by 走 $rt.path，其余按表达式直译 */
const DOTTED_PATH = /^[\w$]+(?:\.[\w$]+)*$/u

/** 表达式步骤：把 schema 里的表达式串翻成箭头函数 */
function emitStepFunction(
  expression: string,
  params: readonly string[],
  ctx: CodegenContext,
): string {
  const body = emitExpression(expression, 'expression', ctx).js
  return `(${params.join(', ')}) => ${body.startsWith('{') ? `(${body})` : body}`
}

/**
 * 数据转换管道 → JS 数组字面量。
 *
 * 十种步骤里只有 `map` / `filter` / `expression` 携带表达式，其余都是纯数据，可以原样
 * 序列化成字面量。表达式统一翻成箭头函数塞进 `fn` / `key`，运行时只认这两个函数位。
 *
 * @returns 空串表示没有管道，产物里不出现 $rt.apply，也就不需要那一段运行时
 */
export function emitTransformPipeline(
  transform: readonly TransformConfig[] | undefined,
  ctx: CodegenContext,
): string {
  if (!transform?.length) return ''

  ctx.runtimeNeeds.add('apply')
  const steps = transform.map((step) => emitStep(step, ctx))
  return `[${steps.join(', ')}]`
}

/**
 * 纯数据步骤写成可读的 JS 对象字面量。
 *
 * 不用 `JSON.stringify`：那会产出 `{"kind":"path"}` 这种带引号键的文本，
 * 出码产物的意义就是人能读能改，键上的引号属于噪音。
 */
function emitDataStep(step: TransformConfig): string {
  switch (step.kind) {
    case 'path':
      return `{ kind: 'path', path: ${quote(step.path)} }`
    case 'pick':
      return `{ kind: 'pick', fields: ${quoteList(step.fields)} }`
    case 'omit':
      return `{ kind: 'omit', fields: ${quoteList(step.fields)} }`
    case 'groupBy':
      return `{ kind: 'groupBy', by: ${quote(step.by)} }`
    default:
      return '{}'
  }
}

function quoteList(values: readonly string[]): string {
  return `[${values.map(quote).join(', ')}]`
}

function emitStep(step: TransformConfig, ctx: CodegenContext): string {
  switch (step.kind) {
    case 'map':
      return `{ kind: 'map', fn: ${emitStepFunction(step.expression, ['item', 'index'], ctx)} }`

    case 'filter':
      return `{ kind: 'filter', fn: ${emitStepFunction(step.expression, ['item', 'index'], ctx)} }`

    case 'expression':
      return `{ kind: 'expression', fn: ${emitStepFunction(step.expression, ['$'], ctx)} }`

    case 'sort': {
      const key = DOTTED_PATH.test(step.by)
        ? `(item) => $rt.path(item, ${quote(step.by)})`
        : emitStepFunction(step.by, ['item'], ctx)
      return `{ kind: 'sort', key: ${key}, order: ${quote(step.order ?? 'asc')} }`
    }

    case 'flatten':
      return `{ kind: 'flatten', depth: ${step.depth ?? 1} }`

    case 'dedupe':
      return `{ kind: 'dedupe', by: ${step.by === undefined ? 'undefined' : quote(step.by)} }`

    default:
      return emitDataStep(step)
  }
}

/** 应用管道；没有管道时直接返回原值表达式 */
function applyPipeline(
  valueExpression: string,
  source: DataSourceSchemaDef,
  ctx: CodegenContext,
): string {
  const pipeline = emitTransformPipeline(source.transform, ctx)
  return pipeline === '' ? valueExpression : `$rt.apply(${valueExpression}, ${pipeline})`
}

/** 状态初值；与 service-datasource 的 initialState 同一套判定 */
function initialOf(source: DataSourceSchemaDef): string {
  const inline =
    source.type === 'mock' && source.config.kind === 'mock'
      ? source.config.data
      : source.type === 'static' && source.config.kind === 'static'
        ? source.config.data
        : undefined

  const data =
    source.type === 'mock' || source.type === 'static' ? emitJsonLiteral(inline) : 'undefined'

  // localStorage 在浏览器里同步可读，初值就按已加载处理，与运行时一致
  const loaded =
    source.type === 'mock' || source.type === 'static' || source.type === 'localStorage'

  return `{ data: ${data}, loading: false, loaded: ${loaded}, error: null }`
}

/**
 * 把 `params` 拼进地址。
 *
 * 与 `service-datasource` 的 `buildRestUrl` 同一算法（不依赖 URL 构造器，相对路径
 * 也能拼）；出码必须在生成时就把查询串接好，否则产物里的 `fetch` 会漏掉参数。
 */
function urlWithParams(url: string, params: Record<string, string> | undefined): string {
  const search = new URLSearchParams(params ?? {}).toString()
  if (search === '') return url
  return `${url}${url.includes('?') ? '&' : '?'}${search}`
}

function restFetch(source: DataSourceSchemaDef, ctx: CodegenContext): string[] {
  const config = source.config
  if (config.kind !== 'rest') return []

  const name = fetchFunctionName(source.id)
  const key = memberKey(source.id)
  const fullUrl = urlWithParams(config.url, config.params)
  const url = fullUrl.includes('{{')
    ? emitExpression(fullUrl, 'template', ctx).js
    : quote(fullUrl)
  const headers = emitJsonLiteral(config.headers ?? {})
  const body = config.body === undefined ? 'undefined' : emitJsonLiteral(config.body)
  const credentials = config.withCredentials ? 'include' : 'same-origin'
  const responseType = config.responseType ?? 'json'

  const read =
    responseType === 'text'
      ? 'const result = await response.text()'
      : responseType === 'blob'
        ? 'const result = await response.blob()'
        : `const text = await response.text()
      let result = null
      if (text.trim() !== '') {
        try {
          result = JSON.parse(text)
        } catch {
          throw new Error('响应不是合法 JSON')
        }
      }`

  const pipeline = emitTransformPipeline(source.transform, ctx)
  const assignment =
    pipeline === ''
      ? `sources[${key}].data = result`
      : `sources[${key}].data = $rt.apply(result, ${pipeline})`

  return [
    `/** ${source.description ?? `接口数据 ${source.id}`}：${config.method ?? 'GET'} ${fullUrl} */`,
    `async function ${name}() {`,
    `  sources[${key}].loading = true`,
    `  sources[${key}].error = null`,
    '  try {',
    `    const headers = new Headers(${headers})`,
    `    const body = ${body}`,
    "    if (body !== undefined && !headers.has('content-type')) {",
    "      headers.set('Content-Type', 'application/json')",
    '    }',
    '',
    `    const response = await fetch(${url}, {`,
    `      method: ${quote(config.method ?? 'GET')},`,
    '      headers,',
    '      body,',
    `      credentials: ${quote(credentials)},`,
    '    })',
    '    if (!response.ok) {',
    '      throw new Error(`HTTP ${response.status} ${response.statusText}`)',
    '    }',
    '',
    `    ${read}`,
    '',
    `    ${assignment}`,
    `    sources[${key}].loaded = true`,
    '  } catch (error) {',
    `    sources[${key}].error =`,
    '      error instanceof Error ? error.message : String(error)',
    '  } finally {',
    `    sources[${key}].loading = false`,
    '  }',
    '}',
  ]
}

function graphqlFetch(source: DataSourceSchemaDef, ctx: CodegenContext): string[] {
  const config = source.config
  if (config.kind !== 'graphql') return []

  const name = fetchFunctionName(source.id)
  const pipeline = emitTransformPipeline(source.transform, ctx)
  const key = memberKey(source.id)
  const assignment =
    pipeline === ''
      ? `sources[${key}].data = payload.data`
      : `sources[${key}].data = $rt.apply(payload.data, ${pipeline})`

  return [
    `/** 接口数据 ${source.id}：GraphQL */`,
    `async function ${name}() {`,
    `  sources[${key}].loading = true`,
    `  sources[${key}].error = null`,
    '  try {',
    `    const response = await fetch(${quote(config.url)}, {`,
    "      method: 'POST',",
    "      headers: new Headers({ 'Content-Type': 'application/json' }),",
    '      body: JSON.stringify({',
    `        query: ${emitText(config.query, ctx)},`,
    `        variables: ${emitJsonLiteral(config.variables ?? {})},`,
    '      }),',
    '    })',
    '    if (!response.ok) {',
    '      throw new Error(`HTTP ${response.status} ${response.statusText}`)',
    '    }',
    '',
    '    const payload = await response.json()',
    '    if (payload.errors?.length) throw new Error(payload.errors[0].message)',
    `    ${assignment}`,
    `    sources[${key}].loaded = true`,
    '  } catch (error) {',
    `    sources[${key}].error = error instanceof Error ? error.message : String(error)`,
    '  } finally {',
    `    sources[${key}].loading = false`,
    '  }',
    '}',
  ]
}

function localStorageFetch(source: DataSourceSchemaDef, ctx: CodegenContext): string[] {
  const config = source.config
  if (config.kind !== 'localStorage') return []

  const name = fetchFunctionName(source.id)
  const key = memberKey(source.id)
  const pipeline = emitTransformPipeline(source.transform, ctx)

  return [
    `/** 本地存储 ${source.id}：读取 ${config.key}，存的是 JSON 就当 JSON 解 */`,
    `function ${name}() {`,
    '  try {',
    `    const raw = window.localStorage.getItem(${quote(config.key)})`,
    `    let result = ${emitJsonLiteral(config.defaultValue)}`,
    '    if (raw !== null) {',
    '      try {',
    '        result = JSON.parse(raw)',
    '      } catch {',
    '        result = raw',
    '      }',
    '    }',
    '',
    `    sources[${key}].data = ${pipeline === '' ? 'result' : `$rt.apply(result, ${pipeline})`}`,
    `    sources[${key}].loaded = true`,
    `    sources[${key}].error = null`,
    '  } catch (error) {',
    `    sources[${key}].error =`,
    '      error instanceof Error ? error.message : String(error)',
    '  }',
    '}',
  ]
}

/** GraphQL query 允许写成模板插值，其余情况是普通字符串字面量 */
function emitText(text: string, ctx: CodegenContext): string {
  return text.includes('{{') ? emitExpression(text, 'template', ctx).js : quote(text)
}

/**
 * 出码一个数据源的状态初值与取数函数。
 *
 * mock 与 static 没有取数过程：声明里的样本已经是初值，所以不生成函数，
 * `MockConfig.delay` 也随之落空——平台运行时同样是同步读声明（`initialState`），
 * 出码若造一个延迟，产物反而和设计器不是同一页。这里报一条提醒而不是静默丢弃。
 */
export function emitDataSource(
  source: DataSourceSchemaDef,
  ctx: CodegenContext,
): EmittedSource {
  if (source.cache) {
    warn(
      ctx,
      `数据源 ${source.id} 声明了缓存策略，平台运行时与出码都未实现缓存，产物按每次实时请求处理。`,
    )
  }

  if (
    source.type === 'mock' &&
    source.config.kind === 'mock' &&
    source.config.delay !== undefined
  ) {
    warn(ctx, `模拟数据源 ${source.id} 的 delay 不生效：初值直接取声明样本，与平台运行时一致。`)
  }

  const fetchLines =
    source.type === 'rest'
      ? restFetch(source, ctx)
      : source.type === 'graphql'
        ? graphqlFetch(source, ctx)
        : source.type === 'localStorage'
          ? localStorageFetch(source, ctx)
          : []

  return {
    id: source.id,
    initial: initialOf(source),
    fetch: fetchLines,
    // 只有存在取数函数时才谈自动取数；mock / static 的初值已经就位
    autoFetch: source.autoFetch !== false && fetchLines.length > 0,
    pollingMs: source.pollingInterval ?? 0,
  }
}

/** 取数函数名，供 onMounted 接线使用 */
export function fetchNameOf(sourceId: string): string {
  return fetchFunctionName(sourceId)
}
