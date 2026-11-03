/**
 * 表达式作用域符号树。
 *
 * 补全需要知道的不只是“有哪些名字”，还要知道 `data.users` 是数组、
 * `data.user.name` 是字符串，才能只给对应类型的方法。符号树由页面声明
 * （变量、数据源 sample、路由声明）静态推导，不读取运行时值，因此设计期
 * 结果稳定，也不会因为接口暂时不可用而闪烁。
 */

import type { ValueTypeSchema } from '@lc/schema'

/**
 * 符号的值类型类别。
 *
 * 与 `@lc/schema` 的 `ValueTypeSchema.kind` 同名同义；单独取别名是因为
 * 符号树只需要类别，不需要字段/元素等递归信息（那些放在 ScopeSymbol 上）。
 */
export type ScopeSymbolKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'unknown'

/**
 * 符号的声明出处，决定补全详情里的来源标注。
 *
 * 生命周期即宿主声明的生命周期：`param` / `callback` 只在一函数或一回调内有效，
 * `data` / `variable` / `datasource` 页面级，`route` 随导航变化。
 */
export type ScopeSymbolSource =
  'param' | 'callback' | 'data' | 'variable' | 'datasource' | 'route' | 'page' | 'loop'

/**
 * 补全可见的一个作用域符号。
 *
 * 设计期由页面声明静态推导（不读运行时值），字段用可选表达「未知即缺省」，
 * 与 ValueTypeSchema 之间可双向转换（scopeSymbolFromType / valueTypeFromScopeSymbol）。
 */
export interface ScopeSymbol {
  /** 在表达式里访问用的名字 */
  name: string
  /** 静态推导出的类型；无法判断时为 unknown */
  kind: ScopeSymbolKind
  /** 补全详情里的说明 */
  description?: string
  /** 数据来源，用于在补全项里标注“接口数据 / 页面变量 / 路由”等 */
  source?: ScopeSymbolSource
  /** 对象字段 */
  children?: readonly ScopeSymbol[]
  /** 数组元素类型 */
  item?: ScopeSymbol
  /** 字段在部分样本中缺失 */
  optional?: boolean
  /** 值可能为 null */
  nullable?: boolean
}

export const SCOPE_SOURCE_LABELS: Readonly<Record<ScopeSymbolSource, string>> = {
  param: '形参',
  callback: '回调参数',
  data: '页面数据',
  variable: '页面变量',
  datasource: '接口数据',
  route: '路由',
  page: '页面',
  loop: '循环变量',
}

export const SYMBOL_KIND_LABELS: Readonly<Record<ScopeSymbolKind, string>> = {
  object: '对象',
  array: '数组',
  string: '字符串',
  number: '数字',
  boolean: '布尔',
  unknown: '未知类型',
}

/** 示例结构可能来自用户粘贴，限制深度与宽度，避免超大 JSON 拖慢补全 */
const MAX_SAMPLE_DEPTH = 6
const MAX_SAMPLE_CHILDREN = 100

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 从运行时值或示例值推导符号类型 */
export function symbolKindOf(value: unknown): ScopeSymbolKind {
  if (Array.isArray(value)) return 'array'
  if (value === null || value === undefined) return 'unknown'

  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'object':
      return 'object'
    default:
      return 'unknown'
  }
}

/**
 * 把一个值转换成符号，对象会递归展开字段。
 *
 * @param name 访问名
 * @param value 示例值或默认值
 * @param options.source 符号来源标注，决定补全详情里的来源徽章
 * @param options.description 选中该符号时的说明文本
 * @param options.depth 内部递归起始深度，受 MAX_SAMPLE_DEPTH 限深；缺省视为 0
 */
export function symbolizeValue(
  name: string,
  value: unknown,
  options: { source?: ScopeSymbolSource; description?: string; depth?: number } = {},
): ScopeSymbol {
  return scopeSymbolFromType(name, valueTypeFromSample(value, options.depth ?? 0), options)
}

/** 合并退化为 unknown 的统一出口；样本含 null 时 nullable 标记必须保留 */
function unknownMerged(nullable: boolean): ValueTypeSchema {
  return { kind: 'unknown', ...(nullable ? { nullable: true } : {}) }
}

/**
 * 合并多个样本值推导出的类型。
 *
 * 数组元素必须逐项合并，否则 `[{id, name}, {id, age}]` 只会提示首项的字段。
 * 合并规则：
 * - 忽略 null/undefined 并标记 nullable；
 * - 同为基础类型直接取该类型；
 * - 对象合并字段，缺失字段标记 optional，字段类型继续递归合并；
 * - 数组递归合并元素类型；
 * - 基础类型不一致或出现未知值时退化为 unknown。
 */
export function mergeValueTypes(types: readonly ValueTypeSchema[]): ValueTypeSchema {
  if (types.length === 0) return { kind: 'unknown' }

  const nullable = types.some((type) => type.nullable === true)
  const opaque = types.some((type) => type.kind === 'unknown' && type.nullable !== true)
  if (opaque) return unknownMerged(nullable)

  const known = types.filter((type) => type.kind !== 'unknown')
  if (known.length === 0) return unknownMerged(nullable)

  const kinds = new Set(known.map((type) => type.kind))
  if (kinds.size > 1) return unknownMerged(nullable)

  const kind = known[0]?.kind ?? 'unknown'

  if (kind === 'object') {
    return {
      kind: 'object',
      fields: mergeObjectFields(known),
      ...(nullable ? { nullable: true } : {}),
    }
  }

  if (kind === 'array') {
    const item = mergeArrayItems(known)
    return {
      kind: 'array',
      ...(item ? { item } : {}),
      ...(nullable ? { nullable: true } : {}),
    }
  }

  return { kind, ...(nullable ? { nullable: true } : {}) }
}

/** 对象字段取并集：未在所有样本出现的字段标 optional，字段类型继续递归合并 */
function mergeObjectFields(known: readonly ValueTypeSchema[]): Record<string, ValueTypeSchema> {
  const names = new Set<string>()
  for (const type of known) {
    for (const name of Object.keys(type.fields ?? {})) names.add(name)
  }

  const fields: Record<string, ValueTypeSchema> = {}
  for (const name of names) {
    const present = known
      .map((type) => type.fields?.[name])
      .filter((field): field is ValueTypeSchema => field !== undefined)

    fields[name] = {
      ...mergeValueTypes(present),
      ...(present.length < known.length ? { optional: true } : {}),
    }
  }

  return fields
}

/** 数组元素类型逐项合并；没有任何样本带元素类型时返回 undefined */
function mergeArrayItems(known: readonly ValueTypeSchema[]): ValueTypeSchema | undefined {
  const items = known
    .map((type) => type.item)
    .filter((item): item is ValueTypeSchema => item !== undefined)

  return items.length > 0 ? mergeValueTypes(items) : undefined
}

/**
 * 从示例值推导值类型。
 *
 * 数组会合并全部元素的结构；对象字段的类型来自字段值；null 只标记可空，
 * 不把整个字段降级为 unknown。
 */
export function valueTypeFromSample(value: unknown, depth = 0): ValueTypeSchema {
  if (depth >= MAX_SAMPLE_DEPTH) return { kind: 'unknown' }
  if (value === null || value === undefined) return { kind: 'unknown', nullable: true }

  const kind = symbolKindOf(value)

  if (kind === 'array') {
    const items = Array.isArray(value)
      ? value.slice(0, MAX_SAMPLE_CHILDREN).map((item) => valueTypeFromSample(item, depth + 1))
      : []

    return items.length > 0
      ? { kind: 'array', item: mergeValueTypes(items) }
      : { kind: 'array' }
  }

  if (kind === 'object' && isPlainObject(value)) {
    const fields: Record<string, ValueTypeSchema> = {}
    for (const [key, child] of Object.entries(value).slice(0, MAX_SAMPLE_CHILDREN)) {
      fields[key] = valueTypeFromSample(child, depth + 1)
    }
    return { kind: 'object', fields }
  }

  return { kind }
}

/** 把类型转成可编辑的示例 JSON，用于形参结构回显 */
export function valueTypeToSample(type: ValueTypeSchema): unknown {
  switch (type.kind) {
    case 'string':
      return 'text'
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'array':
      return type.item ? [valueTypeToSample(type.item)] : []
    case 'object': {
      const sample: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(type.fields ?? {})) {
        sample[key] = valueTypeToSample(child)
      }
      return sample
    }
    default:
      return null
  }
}

/** 作用域符号转值类型，供推断使用 */
export function valueTypeFromScopeSymbol(symbol: ScopeSymbol): ValueTypeSchema {
  const type: ValueTypeSchema = {
    kind: symbol.kind,
    ...(symbol.description ? { description: symbol.description } : {}),
    ...(symbol.optional ? { optional: true } : {}),
    ...(symbol.nullable ? { nullable: true } : {}),
  }

  if (symbol.children && symbol.children.length > 0) {
    const fields: Record<string, ValueTypeSchema> = {}
    for (const child of symbol.children) fields[child.name] = valueTypeFromScopeSymbol(child)
    type.fields = fields
  }

  if (symbol.item) type.item = valueTypeFromScopeSymbol(symbol.item)

  return type
}

/**
 * 递归展开对象子字段与数组元素符号。
 *
 * 子级只继承来源、不继承本层 description，否则每个字段都会重复显示父级说明。
 */
function compositeSymbolParts(
  type: ValueTypeSchema,
  childOptions: { source?: ScopeSymbolSource },
): Pick<ScopeSymbol, 'children' | 'item'> {
  const parts: Pick<ScopeSymbol, 'children' | 'item'> = {}

  if (type.fields) {
    parts.children = Object.entries(type.fields).map(([key, child]) =>
      scopeSymbolFromType(key, child, childOptions),
    )
  }

  if (type.item) parts.item = scopeSymbolFromType('item', type.item, childOptions)

  return parts
}

/**
 * 值类型转作用域符号，供函数形参进入补全。
 *
 * @param options.source 符号来源；子字段只继承来源、不继承本层说明
 * @param options.description 本层说明文本；缺省时落到 `type.description`
 */
export function scopeSymbolFromType(
  name: string,
  type: ValueTypeSchema,
  options: { source?: ScopeSymbolSource; description?: string } = {},
): ScopeSymbol {
  const description = options.description ?? type.description
  const childOptions = options.source ? { source: options.source } : {}

  return {
    name,
    kind: type.kind,
    ...(options.source ? { source: options.source } : {}),
    ...(description ? { description } : {}),
    ...(type.optional ? { optional: true } : {}),
    ...(type.nullable ? { nullable: true } : {}),
    ...compositeSymbolParts(type, childOptions),
  }
}

/** 作用域符号列表转推断用的变量类型表 */
export function symbolsToTypeEnv(
  symbols: readonly ScopeSymbol[] | undefined,
): Record<string, ValueTypeSchema> {
  const env: Record<string, ValueTypeSchema> = {}
  for (const symbol of symbols ?? []) env[symbol.name] = valueTypeFromScopeSymbol(symbol)
  return env
}

/**
 * 批量转换示例对象的字段；数组与标量返回空数组。
 *
 * @param options.source 给每个生成字段统一贴上的来源徽章
 * @param options.depth 递归起始深度；本批字段按 `depth + 1` 层生成，缺省视为 0
 */
export function symbolsFromSample(
  value: unknown,
  options: { source?: ScopeSymbolSource; depth?: number } = {},
): ScopeSymbol[] {
  if (!isPlainObject(value)) return []

  return Object.entries(value)
    .slice(0, MAX_SAMPLE_CHILDREN)
    .map(([key, child]) =>
      symbolizeValue(key, child, {
        source: options.source,
        depth: (options.depth ?? 0) + 1,
      }),
    )
}
