import type {
  DataSourceSchemaDef,
  PageRouteSchema,
  PageSchema,
  PageVariableSchema,
  RouteFieldSchema,
} from '@lc/schema'
import type { ScopeSymbol } from './scope'
import { scopeSymbolFromType, symbolizeValue } from './scope'

/** 宿主路由运行时值；设计器里可以省略，只按声明生成未知类型字段 */
export interface PageRouteRuntime {
  /** 路径参数（如 `/user/:id` 的 id）；设计期来自宿主注入 */
  params?: Record<string, unknown>
  /** 查询参数（`?a=1`）；值一律按字符串样本推导 */
  query?: Record<string, unknown>
}

/** mock/static 的示例就是真实数据；其余类型只认 sample */
function dataSourceSample(source: DataSourceSchemaDef): unknown {
  if (source.sample !== undefined) return source.sample
  if (source.type === 'mock' && source.config.kind === 'mock') return source.config.data
  if (source.type === 'static' && source.config.kind === 'static') return source.config.data
  return undefined
}

function routeFields(
  declared: readonly RouteFieldSchema[] | undefined,
  actual: Record<string, unknown> | undefined,
): ScopeSymbol[] {
  const descriptions = new Map((declared ?? []).map((field) => [field.name, field.description]))
  const fields = new Map<string, ScopeSymbol>()

  for (const field of declared ?? []) {
    fields.set(field.name, {
      name: field.name,
      kind: 'unknown',
      source: 'route',
      ...(field.description ? { description: field.description } : {}),
    })
  }

  for (const [name, value] of Object.entries(actual ?? {})) {
    fields.set(
      name,
      symbolizeValue(name, value, {
        source: 'route',
        description: descriptions.get(name),
      }),
    )
  }

  return [...fields.values()]
}

/** 数据源结果符号：显式 resultType 声明优先，否则按示例值推导 */
function datasourcePayloadSymbol(source: DataSourceSchemaDef): ScopeSymbol {
  if (source.resultType) {
    return scopeSymbolFromType('data', source.resultType, {
      source: 'datasource',
      description: '接口结果',
    })
  }

  return symbolizeValue('data', dataSourceSample(source), {
    source: 'datasource',
    description: '接口结果',
  })
}

/**
 * 表达式里数据源是请求状态对象：`data.<id>.data` 取结果，
 * 其余固定字段承载 loading / loaded / error。
 */
function datasourceSymbol(source: DataSourceSchemaDef): ScopeSymbol {
  return {
    name: source.id,
    kind: 'object',
    source: 'datasource',
    ...(source.description ? { description: source.description } : {}),
    children: [
      datasourcePayloadSymbol(source),
      {
        name: 'loading',
        kind: 'boolean',
        source: 'datasource',
        description: '是否正在请求',
      },
      {
        name: 'loaded',
        kind: 'boolean',
        source: 'datasource',
        description: '是否已成功加载',
      },
      {
        name: 'error',
        kind: 'string',
        source: 'datasource',
        description: '错误信息，无错误时为 null',
      },
    ],
  }
}

/** 页面变量符号：声明类型优先，缺省按默认值推导 */
function variableSymbol(variable: PageVariableSchema): ScopeSymbol {
  if (variable.type) {
    return scopeSymbolFromType(variable.name, variable.type, {
      source: 'variable',
      description: variable.description,
    })
  }

  return symbolizeValue(variable.name, variable.defaultValue, {
    source: 'variable',
    description: variable.description,
  })
}

/** 把一组路由字段包装成对象符号；`$params` / `$query` 与 `$route` 下的对应节点共用 */
function routeGroupSymbol(
  name: string,
  description: string,
  fields: readonly ScopeSymbol[],
): ScopeSymbol {
  return { name, kind: 'object', source: 'route', description, children: fields }
}

/**
 * `$route` 整体信息符号。
 *
 * 静态字段（path / fullPath / name / hash）来自 vue-router 的 RouteLocation 形状，
 * 不随页面声明变化；`name` 是路由记录名，未命名路由时为 unknown。
 */
function routeInfoSymbol(
  paramsFields: readonly ScopeSymbol[],
  queryFields: readonly ScopeSymbol[],
): ScopeSymbol {
  return {
    name: '$route',
    kind: 'object',
    source: 'route',
    description: '当前路由信息',
    children: [
      { name: 'path', kind: 'string', source: 'route' },
      { name: 'fullPath', kind: 'string', source: 'route' },
      { name: 'name', kind: 'unknown', source: 'route' },
      { name: 'hash', kind: 'string', source: 'route' },
      { name: 'params', kind: 'object', source: 'route', children: paramsFields },
      { name: 'query', kind: 'object', source: 'route', children: queryFields },
    ],
  }
}

/**
 * 组装路由三个符号：`$params`、`$query`、`$route`。
 *
 * `$route.params` / `$route.query` 与前两者共享同一份字段列表：
 * 两种写法访问的是同一个运行时对象，符号树分叉会让补全口径不一致。
 */
function routeSymbols(
  declared: PageRouteSchema | undefined,
  route: PageRouteRuntime | undefined,
): ScopeSymbol[] {
  const paramsFields = routeFields(declared?.params, route?.params)
  const queryFields = routeFields(declared?.query, route?.query)

  return [
    routeGroupSymbol('$params', '当前路由参数', paramsFields),
    routeGroupSymbol('$query', '当前查询参数', queryFields),
    routeInfoSymbol(paramsFields, queryFields),
  ]
}

/**
 * 从页面声明生成表达式补全可见的符号树。
 *
 * 函数体编辑器只传形参、不传这份结果：自定义函数保持纯函数语义，
 * 页面数据应在调用处作为实参传入，而不是被函数体隐式捕获。
 *
 * @param schema 页面 schema
 * @param route 当前路由值；省略时只生成声明字段（unknown 类型）
 */
export function buildPageSymbols(schema: PageSchema, route?: PageRouteRuntime): ScopeSymbol[] {
  const dataChildren = new Map<string, ScopeSymbol>()

  for (const source of schema.datasources ?? []) {
    dataChildren.set(source.id, datasourceSymbol(source))
  }

  for (const variable of schema.variables ?? []) {
    dataChildren.set(variable.name, variableSymbol(variable))
  }

  const data: ScopeSymbol = {
    name: 'data',
    kind: 'object',
    source: 'data',
    description: '页面变量与数据源结果',
    children: [...dataChildren.values()],
  }

  const page = symbolizeValue('page', schema.metadata ?? {}, {
    source: 'page',
    description: '页面元数据',
  })

  return [data, page, ...routeSymbols(schema.route, route)]
}
