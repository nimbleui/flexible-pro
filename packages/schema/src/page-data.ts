import type { DataSourceSchemaDef } from './datasource'
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
 */
export function buildPageData(
  schema: PageSchema,
  states?: Readonly<Record<string, DataSourceRuntimeState>>,
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
    data[variable.name] = variable.defaultValue
  }

  return data
}
