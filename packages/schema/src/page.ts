import type { ComponentSchema } from './component'
import type { DataSourceSchemaDef } from './datasource'
import type { FunctionSchema } from './functions'
import type { LifecycleSchema } from './lifecycle'
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
   * 页面的数据源配置列表（可选）
   * 用于声明页面级别的数据获取和状态管理。
   */
  datasources?: DataSourceSchemaDef[]
  /**
   * 页面的生命周期钩子列表（可选）
   * 用于在页面级生命周期事件中执行自定义逻辑。
   */
  lifecycles?: LifecycleSchema[]
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
