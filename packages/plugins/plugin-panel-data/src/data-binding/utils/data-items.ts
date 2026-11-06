import type { DataSourceSchemaDef, PageSchema, ValueTypeSchema } from '@lc/schema'
import { valueTypeFromSample } from '@lc/expression/editor'

/** 数据项属于哪一组 */
export type DataItemKind = 'variable' | 'source' | 'function' | 'route'

/** 左列的一行数据项 */
export interface DataItem {
  kind: DataItemKind
  /** 展示名 */
  name: string
  /**
   * 表达式里怎么写这一项，如 `data.count`、`$params.id`、`progress`。
   *
   * 引用反查按它做前缀匹配，所以这一段拼法必须和表达式里的写法一致，
   * 不能为了好看改成 `data.<count>` 之类的展示格式。
   */
  path: string
  /** 一行副标题：类型、结构或函数签名 */
  detail: string
  /** 作者写的说明 */
  description?: string
}

/** 分组标题；左列按这个顺序分组 */
export const DATA_GROUP_LABELS: Record<DataItemKind, string> = {
  variable: '变量',
  source: '接口数据',
  function: '函数',
  route: '路由参数',
}

/** 数据源类型的展示名；与页面数据弹框的措辞保持一致 */
const SOURCE_TYPE_LABELS: Record<DataSourceSchemaDef['type'], string> = {
  rest: 'REST 接口',
  graphql: 'GraphQL',
  mock: '模拟数据',
  static: '静态数据',
  localStorage: '本地存储',
}

/** 类型结构的短标签：对象带成员数、数组带元素类型 */
function typeLabel(type: ValueTypeSchema | undefined): string | undefined {
  if (!type || type.kind === 'unknown') return undefined

  switch (type.kind) {
    case 'object': {
      const count = Object.keys(type.fields ?? {}).length
      return count === 0 ? 'object' : `object{${count}}`
    }
    case 'array': {
      const item = typeLabel(type.item)
      return item ? `${item}[]` : 'array'
    }
    default:
      return type.kind
  }
}

/** 没有类型标注时按默认值推一个短类型名；undefined 表示作者没填默认值 */
function valueLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (value === null) return 'null'
  if (Array.isArray(value)) return `${value.length} 项`
  if (typeof value === 'object') return `object{${Object.keys(value).length}}`
  return typeof value
}

/** 依次取第一个能用的标签，全都没有时给出「未标注」而不是空串 */
function firstLabel(...labels: (string | undefined)[]): string {
  return labels.find((label) => label !== undefined && label !== '') ?? '未标注类型'
}

function sourceDetail(source: DataSourceSchemaDef): string {
  const type = SOURCE_TYPE_LABELS[source.type]
  const shape = firstLabel(
    typeLabel(source.resultType),
    typeLabel(valueTypeFromSample(sampleOf(source))),
  )
  return `${type} · ${shape}`
}

/**
 * 数据源的示例结构。
 *
 * 只有 mock / static 自带数据；REST 在设计期拿不到真实返回，`sample` 是作者手填的
 * 结构样本，两者都缺省时返回 undefined，由 `valueTypeFromSample` 兜成 unknown。
 */
function sampleOf(source: DataSourceSchemaDef): unknown {
  if (source.sample !== undefined) return source.sample
  return source.config.kind === 'mock' || source.config.kind === 'static'
    ? source.config.data
    : undefined
}

/**
 * 左列数据项清单。
 *
 * 顺序即分组顺序：变量与接口数据共用 `data` 命名空间，放在最前；函数与路由参数
 * 是另外两套作用域键，分开列才不会让人以为 `progress` 也能写成 `data.progress`。
 */
export function listDataItems(schema: PageSchema): DataItem[] {
  const items: DataItem[] = []

  for (const variable of schema.variables ?? []) {
    items.push({
      kind: 'variable',
      name: variable.name,
      path: `data.${variable.name}`,
      detail: firstLabel(typeLabel(variable.type), valueLabel(variable.defaultValue)),
      description: variable.description,
    })
  }

  for (const source of schema.datasources ?? []) {
    items.push({
      kind: 'source',
      name: source.id,
      path: `data.${source.id}`,
      detail: sourceDetail(source),
      description: source.description,
    })
  }

  for (const fn of schema.functions ?? []) {
    const params = fn.params ?? []
    items.push({
      kind: 'function',
      name: fn.name,
      path: fn.name,
      detail: `${fn.name}(${params.join(', ')})`,
      description: fn.title,
    })
  }

  for (const [group, fields] of [
    ['$params', schema.route?.params] as const,
    ['$query', schema.route?.query] as const,
  ]) {
    for (const field of fields ?? []) {
      items.push({
        kind: 'route',
        name: field.name,
        path: `${group}.${field.name}`,
        detail: group,
        description: field.description,
      })
    }
  }

  return items
}
