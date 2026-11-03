import type { ActionDeclaration, EventConnection } from './actions'
import type { ComponentSchema } from './component'
import type { DataSourceSchemaDef } from './datasource'
import type { FunctionSchema, ValueTypeSchema } from './functions'
import type { ComponentPropsMap, DefaultComponentPropsMap, NodeSchema } from './node'

/**
 * 页面元数据接口
 * 描述页面的基本信息，用于 SEO、页面预览和文档管理。
 */
export interface PageMeta {
  /** 页面的显示标题 */
  title: string
  /** 页面的描述摘要（可选），用于搜索引擎结果展示 */
  description?: string
  /** 页面的 SEO 关键词列表（可选） */
  keywords?: string[]
  /** 页面作者信息（可选） */
  author?: string
}

/**
 * 页面变量声明。
 *
 * 变量与数据源结果共享 `data` 命名空间，例如 `data.isEditing`。
 * 变量默认值是运行时初值，同时也是编辑器推导补全类型的依据。
 */
export interface PageVariableSchema {
  /** 变量名；必须能作为标识符在表达式中访问 */
  name: string
  /**
   * 变量类型声明（可选）。
   *
   * 缺省时按 `defaultValue` 推导；显式声明后，即使默认值为空也能参与补全。
   */
  type?: ValueTypeSchema
  /** 初始值；对象/数组按 JSON 结构参与补全推导 */
  defaultValue?: unknown
  /** 说明（可选），显示在补全详情里 */
  description?: string
}

/** 路由字段声明；只描述名字与含义，值由运行时路由提供 */
export interface RouteFieldSchema {
  /** 参数或查询键名 */
  name: string
  /** 说明（可选） */
  description?: string
}

/**
 * 页面路由契约。
 *
 * 这里只声明页面“期望收到”的参数名，不存运行时值：
 * `$params` / `$query` 的真实内容由宿主路由注入。声明的作用是让编辑器
 * 在设计期就能提示 `$params.id` 这类路径。
 */
export interface PageRouteSchema {
  /** 路径参数声明 */
  params?: RouteFieldSchema[]
  /** 查询参数声明 */
  query?: RouteFieldSchema[]
}

/**
 * 页面架构接口
 * PageSchema 是整个架构体系的顶层文档结构，对应于一个完整的页面或应用。
 * 渲染器根据此结构递归遍历节点树生成实际 UI；
 * 编辑器将此结构解析为可交互的可视化编辑状态。
 *
 * 典型用法：
 * ```json
 * {
 *   "version": "1.0.0",
 *   "root": { "id": "root", "componentName": "Container", ... },
 *   "components": [ { "meta": { "name": "Button", ... }, ... } ],
 *   "theme": { "id": "default", "name": "默认主题", ... }
 * }
 * ```
 *
 * 泛型参数 T 为「组件名 -> 属性类型」的映射表，将传递给内部的 NodeSchema
 * 与 ComponentSchema，从而让页面节点树中的 componentName 能自动推导对应的 props。
 */
export interface PageSchema<T extends ComponentPropsMap = DefaultComponentPropsMap> {
  /**
   * 架构版本号
   * 用于在加载时校验架构兼容性，版本不匹配时可触发迁移逻辑。
   * 需与 SCHEMA_VERSION 常量保持一致。
   */
  version: string
  /** 起始节点id */
  nodeId: string
  /**
   * 页面根节点
   * 整个组件树的入口点，渲染器从此节点开始递归渲染。
   */
  nodes: { [key: string]: NodeSchema<T> }
  /**
   * 页面中使用的组件注册列表
   * 每个组件定义了其元数据、属性、事件和插槽等信息。
   * 渲染器根据节点中的 componentName 在此列表中查找对应的组件定义。
   */
  components: ComponentSchema<T>[]
  /**
   * 页面动作表（可选）
   * 键为动作 id。动作是「事件连接」的执行单元：连接只存 id 列表，动作本体独立成表，
   * 便于同一动作被多个事件复用、也便于单独做版本迁移与审计。
   */
  actions?: Record<string, ActionDeclaration>
  /**
   * 事件连接表（可选）
   * 键为连接 id。一条连接 = 「某节点的某事件 → 按序执行一串动作」，顺序即执行顺序。
   */
  connections?: Record<string, EventConnection>
  /**
   * 页面的数据源配置列表（可选）
   * 用于声明页面级别的数据获取和状态管理。
   */
  datasources?: DataSourceSchemaDef[]
  /**
   * 页面变量声明（可选）
   * 默认值参与运行时装配，类型结构参与表达式补全。
   */
  variables?: PageVariableSchema[]
  /**
   * 页面路由契约（可选）
   * 只声明参数名，运行时值由宿主路由注入。
   */
  route?: PageRouteSchema
  /**
   * 页面级声明式函数列表（可选）
   * 将自动注册到表达式引擎，供模板/条件/事件表达式使用，
   * 帮助在不写代码的前提下抽取重复逻辑（例如“进度拼接”、“邮箱校验”）。
   */
  functions?: FunctionSchema[]
  /** 页面的主题配置（可选），用于统一定义颜色、间距、字体等设计令牌 */
  // theme?: ThemeConfig;
  /** 页面的元数据信息（可选） */
  metadata?: PageMeta
}
