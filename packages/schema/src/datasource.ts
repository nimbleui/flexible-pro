/**
 * 数据源（DataSource）架构定义
 * 本文件定义了组件和页面中数据获取与处理的完整配置体系。
 * 支持的数据源类型包括：
 * - REST API 接口
 * - GraphQL 查询
 * - Mock（模拟数据）
 * - 静态/字面量数据
 * - 浏览器 LocalStorage
 * 此外还提供了缓存配置和数据转换配置，用于数据获取后的处理。
 */

/**
 * 支持的数据源类型字面量联合
 * - 'rest': RESTful API 接口
 * - 'graphql': GraphQL 查询接口
 * - 'mock': 模拟数据，用于开发和测试
 * - 'static': 静态/硬编码数据
 * - 'localStorage': 浏览器本地存储
 */
export type DataSourceType = 'rest' | 'graphql' | 'mock' | 'static' | 'localStorage'

/**
 * REST API 配置接口
 * 定义通过 HTTP 请求获取数据所需的全部参数
 */
export interface RestConfig {
  /** 类型标识，固定为 'rest'，用于可辨识联合类型收窄 */
  kind: 'rest'
  /** 请求的目标 URL 地址 */
  url: string
  /** HTTP 请求方法，默认为 GET */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  /** 请求自定义头部，键值对格式 */
  headers?: Record<string, string>
  /** URL 查询参数，键值对格式 */
  params?: Record<string, string>
  /** 请求体数据（用于 POST/PUT/PATCH 等方法） */
  body?: unknown
  /** 是否在跨域请求中携带凭据（cookies、HTTP 认证等） */
  withCredentials?: boolean
  /** 期望的响应数据格式，默认为 'json' */
  responseType?: 'json' | 'text' | 'blob'
}

/**
 * GraphQL 配置接口
 * 定义通过 GraphQL 查询获取数据的参数
 */
export interface GraphQLConfig {
  /** 类型标识，固定为 'graphql'，用于可辨识联合类型收窄 */
  kind: 'graphql'
  /** GraphQL 服务端地址 */
  url: string
  /** GraphQL 查询语句（query 或 mutation） */
  query: string
  /** 查询变量，用于参数化查询 */
  variables?: Record<string, unknown>
  /** 请求自定义头部 */
  headers?: Record<string, string>
}

/**
 * Mock（模拟）数据配置接口
 * 用于开发阶段提供假数据，模拟真实接口返回
 */
export interface MockConfig {
  /** 类型标识，固定为 'mock'，用于可辨识联合类型收窄 */
  kind: 'mock'
  /** 模拟数据的内容，可以是任何类型的数据结构 */
  data: unknown
  /** 模拟的网络延迟时间（毫秒），用于模拟实际请求耗时 */
  delay?: number
}

/**
 * 静态数据配置接口
 * 用于直接定义常量数据，不涉及网络请求
 */
export interface StaticConfig {
  /** 类型标识，固定为 'static'，用于可辨识联合类型收窄 */
  kind: 'static'
  /** 静态数据的值 */
  data: unknown
}

/**
 * LocalStorage 配置接口
 * 从浏览器本地存储中读取持久化数据
 */
export interface LocalStorageConfig {
  /** 类型标识，固定为 'localStorage'，用于可辨识联合类型收窄 */
  kind: 'localStorage'
  /** LocalStorage 中存储项的键名 */
  key: string
  /** 当指定键不存在时的默认值（可选） */
  defaultValue?: unknown
}

/**
 * 数据源配置可辨识联合类型
 * 包含所有受支持数据源类型的配置结构。
 * 每个变体通过 `kind` 字段进行辨识，使得 TypeScript 能够通过
 * `config.kind === 'rest'` 等条件判断自动收窄类型。
 */
export type DataSourceConfig =
  RestConfig | GraphQLConfig | MockConfig | StaticConfig | LocalStorageConfig

// ---------------- 数据转换管道 ---------------- //

/**
 * 沿指定点路径提取子字段。
 * 典型场景：后端结果包一层 `{ code, data: {...} }`，只留 `data`。
 * 例：`{ kind: 'path', path: 'data.items' }`
 */
export interface PathTransform {
  kind: 'path'
  /** 点分隔的字段路径（支持多层） */
  path: string
}

/** 仅保留指定字段（对数组逐项应用；对对象直接应用） */
export interface PickTransform {
  kind: 'pick'
  /** 保留的字段名列表 */
  fields: string[]
}

/** 排除指定字段 */
export interface OmitTransform {
  kind: 'omit'
  /** 需要去除的字段名列表 */
  fields: string[]
}

/**
 * 对数组逐项应用表达式。
 * 表达式作用域：`item`（当前项）、`index`（下标）、`list`（整个数组）。
 * 例：`{ kind: 'map', expression: '{ id: item.id, name: item.title }' }`
 */
export interface MapTransform {
  kind: 'map'
  /** 表达式，可包含可选的 `{{ }}` 包裹 */
  expression: string
}

/** 对数组过滤：表达式返回真才保留。作用域同 Map。 */
export interface FilterTransform {
  kind: 'filter'
  /** 返回布尔值的表达式，例如 `!item.done` */
  expression: string
}

/** 数组排序：按字段路径 或 任意表达式 计算每项的比较键。 */
export interface SortTransform {
  kind: 'sort'
  /**
   * 比较键。两种写法：
   *  - 字段名（支持点路径）：`'meta.priority'`
   *  - 表达式（拿取 item）：`'{{ item.title.length }}'`
   */
  by: string
  /** 排序方向，默认 asc */
  order?: 'asc' | 'desc'
}

/** 数组打平（默认一层） */
export interface FlattenTransform {
  kind: 'flatten'
  /** 打平层数，默认 1；Infinity 表示递归到底 */
  depth?: number
}

/** 数组去重（可按 key） */
export interface DedupeTransform {
  kind: 'dedupe'
  /** 识别重复项的字段路径，不传则按值本身判断 */
  by?: string
}

/** 按字段分组：结果为 Record<key, item[]> */
export interface GroupByTransform {
  kind: 'groupBy'
  /** 分组依据的字段路径 */
  by: string
}

/**
 * 对整个数据应用一个表达式（非逐项）。
 * 作用域：`$` 代表当前数据。
 * 例：`{ kind: 'expression', expression: '$.list || []' }`
 */
export interface ExpressionTransform {
  kind: 'expression'
  /** 对整体应用的表达式 */
  expression: string
}

/**
 * 单个转换步骤的可辨识联合类型。
 * 在 DataSourceSchemaDef.transform 中声明一个步骤数组，
 * 取数完成后管道会按顺序依次应用，前一步的输出作为后一步的输入。
 */
export type TransformConfig =
  | PathTransform
  | PickTransform
  | OmitTransform
  | MapTransform
  | FilterTransform
  | SortTransform
  | FlattenTransform
  | DedupeTransform
  | GroupByTransform
  | ExpressionTransform

// ---------------- 缓存配置 ---------------- //

/**
 * 缓存存储策略：
 *  - memory:         当前 Renderer 实例内存（页面刷新即丢失）
 *  - localStorage:   浏览器本地存储（跨会话保留）
 *  - sessionStorage: 浏览器会话存储（关页丢失）
 */
export type CacheStrategy = 'memory' | 'localStorage' | 'sessionStorage'

/**
 * 数据源缓存配置。
 * 命中新鲜缓存时可避免一次网络请求；命中过期缓存的行为由
 * `staleWhileRevalidate` 控制——开时先展旧数后台刷新，关时彻底重新拉取。
 */
export interface CacheConfig {
  /** 存储策略 */
  strategy: CacheStrategy
  /** 有效期（毫秒）；未指定时仅作为“死后备份”（一直命中但每次仍重拉） */
  ttl?: number
  /** 自定义缓存 key；未指定时默认使用 `agile:ds:<datasource.id>` */
  key?: string
  /**
   * stale-while-revalidate 策略：
   *  - true:  命中旧缓存立即写入 state，后台重拉后再写一次（面向用户零等待）
   *  - false / undefined: 命中后仍重新拉取。
   */
  staleWhileRevalidate?: boolean
}

/**
 * 数据源架构定义接口
 * 完整描述一个数据源的配置，包括来源类型、具体配置、
 * 自动获取行为、轮询、数据转换及缓存策略。
 */
export interface DataSourceSchemaDef {
  /** 数据源唯一标识 ID */
  id: string
  /** 数据源类型 */
  type: DataSourceType
  /** 数据源的具体配置（根据 type 不同，对应不同的配置接口） */
  config: DataSourceConfig
  /** 是否在页面/组件初始化时自动触发数据获取 */
  autoFetch?: boolean
  /** 轮询间隔（毫秒），设置后将定期自动刷新数据 */
  pollingInterval?: number
  /**
   * 数据转换管道，按顺序依次执行。
   * 在“拉取完成”与“写入 state”之间应用，前一步的输出作为后一步的输入。
   */
  transform?: TransformConfig[]
  /**
   * 缓存配置，控制数据的缓存行为（命中后直接写入 state）。
   * 支持内存 / localStorage / sessionStorage 三种存储，
   * 可配 TTL 与 stale-while-revalidate 策略。
   */
  cache?: CacheConfig
}
