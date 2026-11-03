import type { DataSourceSchemaDef } from './datasource'
import type { ExpressionScope } from './expression'
import type { PageSchema } from './page'

/**
 * 数据源运行时状态的结构镜像。
 *
 * schema 包不依赖 contracts，因此这里只描述渲染层需要的字段形状；
 * 真正的状态由数据源服务提供。
 */
export interface DataSourceRuntimeState {
  /** 最近一次成功取数的结果；未取数或失败后仍保留上一次的值，便于表达式稳定读字段 */
  readonly data: unknown
  /** 是否有一次请求在途；轮询期间的第二次拉取同样为 true */
  readonly loading: boolean
  /** 是否已成功完成过至少一次取数；用于区分「拿到空结果」与「还没拿过」 */
  readonly loaded: boolean
  /** 最近一次失败的文案；成功后必须清空为 null，否则表达式无法判断当前是否可用 */
  readonly error: string | null
}

/**
 * 取一个数据源在设计器里能立即拿到的值。
 *
 * 只有 mock / static 带自有数据；REST / GraphQL 需要真正的数据源运行时，
 * localStorage 需要浏览器环境，都不在本纯函数里处理，返回 undefined。
 */
export function resolveDataSourceValue(source: DataSourceSchemaDef): unknown {
  if (source.type === 'mock' && source.config.kind === 'mock') return source.config.data
  if (source.type === 'static' && source.config.kind === 'static') return source.config.data
  return undefined
}

/**
 * 按页面声明装配表达式作用域里的 `data`。
 *
 * 数据源统一输出状态对象 `{ data, loading, loaded, error }`：结果与请求状态
 * 在表达式里是同一棵树，`data.users.data` 取结果，`data.users.loading` 看状态。
 * 先放数据源、再放变量：变量是页面显式状态，同名时覆盖数据源；正常流程由
 * 页面数据弹框禁止跨类重名。
 *
 * 用 null 原型对象承载：变量名来自用户输入，直接赋值到普通对象上可能
 * 触发 `__proto__` 之类的原型污染。
 *
 * @param schema 页面 schema
 * @param states 数据源服务提供的运行时状态；缺省时按声明生成静态/未取数状态
 * @param variables 状态服务提供的变量当前值；缺省时回落到声明的 `defaultValue`。
 *   设计态没有状态服务，走缺省分支即可得到「所见即初值」的效果；运行时必须传入，
 *   否则 `state.set` 写进去的值在后续表达式里读不到。
 */
export function buildPageData(
  schema: PageSchema,
  states?: Readonly<Record<string, DataSourceRuntimeState>>,
  variables?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const data: Record<string, unknown> = Object.create(null)

  for (const source of schema.datasources ?? []) {
    data[source.id] = states?.[source.id] ?? {
      data: resolveDataSourceValue(source),
      loading: false,
      loaded: source.type === 'mock' || source.type === 'static',
      error: null,
    }
  }

  for (const variable of schema.variables ?? []) {
    data[variable.name] =
      variables && variable.name in variables ? variables[variable.name] : variable.defaultValue
  }

  return data
}

/** 装配表达式作用域所需的输入 */
export interface ExpressionScopeInput {
  /** 页面 schema */
  schema: PageSchema
  /** 数据源运行时状态 */
  dataSources?: Readonly<Record<string, DataSourceRuntimeState>>
  /** 页面变量当前值 */
  variables?: Readonly<Record<string, unknown>>
  /** 本次事件的参数；缺省时表达式里的 `event` 是空对象而不是 undefined */
  event?: Readonly<Record<string, unknown>>
  /** 宿主贡献的作用域（如 `$route`）；后于内置键展开会被覆盖，故先展开 */
  base?: ExpressionScope
}

/**
 * 装配一次求值所需的完整表达式作用域。
 *
 * 渲染层与动作执行器共用这一个装配函数，是因为作用域形状必须只有一份定义：
 * 两边各拼一次，早晚会在「`event` 到底是对象还是 undefined」这类细节上分叉，
 * 而这种分叉只在运行时暴露。
 *
 * 顶层键固定为 `data` / `page` / `event`，宿主键（`$route` 等）由 `base` 带入。
 * `event` 恒为对象：事件参数缺省时表达式写 `event.value` 得到 undefined，
 * 而不是在访问 `undefined.value` 时抛错。
 *
 * @param input 装配输入
 * @returns 可直接交给 `ExpressionEngine` 的作用域对象
 */
export function buildExpressionScope(input: ExpressionScopeInput): ExpressionScope {
  const scope: Record<string, unknown> = { ...(input.base ?? {}) }

  scope.data = buildPageData(input.schema, input.dataSources, input.variables)
  scope.page = input.schema.metadata
  scope.event = { ...(input.event ?? {}) }

  return scope
}
