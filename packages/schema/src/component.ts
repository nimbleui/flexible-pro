import type { DataSourceSchemaDef } from './datasource'
import type { EventDefinition } from './events'
import type { FunctionSchema } from './functions'
import type { ComponentPropsMap, DefaultComponentPropsMap, NodeSchema } from './node'
import type { PropDefinition, PropValue } from './props'
import type { SlotDefinition } from './slots'
/**
 * 组件元数据接口
 * 描述一个组件的基本信息，用于编辑器组件面板展示和检索
 */
export interface ComponentMeta {
  /** 组件名称标识，如 "Button" */
  name: string
  /** 组件显示标题，如 "按钮" */
  title: string
  /** 组件所属分组，如 "Form"（表单），用于在编辑器面板中对组件进行分类 */
  group: string
  /** 组件图标的 CSS 类名或图标名称（可选） */
  icon?: string
  /** 组件版本号，遵循 semver 规范 */
  version: string
  /** 组件功能描述文本（可选） */
  description?: string
  /** 组件搜索关键词列表，用于在编辑器中快速检索（可选） */
  keywords?: string[]
  /** 组件在分组内的排序序号（可选），数字越小越靠前 */
  order?: number
}

/**
 * 组件预置代码片段接口
 * 定义了一个可复用的组件预设，包含完整的配置信息和初始属性值。
 * 使用者可以直接从编辑器面板拖拽使用，无需从头配置。
 *
 * 泛型参数 T 为「组件名 -> 属性类型」的映射表，将传递给内部的 NodeSchema，
 * 从而让 schema 中的 componentName 能自动推导对应的 props。
 */
export interface SnippetSchema<T extends ComponentPropsMap = DefaultComponentPropsMap> {
  /** 片段的显示名称 */
  title: string
  /** 片段的描述文本（可选） */
  description?: string
  /** 片段对应的完整节点架构（包含预置的属性、样式、事件等） */
  schema: NodeSchema<T>
  /** 片段在面板中的图标（可选） */
  icon?: string
}

/**
 * 组件完整定义接口
 * 这是组件的顶层描述结构，整合了元数据、属性定义、事件定义、插槽定义
 * 以及默认属性和预置片段等全部信息，用于在编辑器中注册一个可用组件。
 *
 * 泛型参数 T 为「组件名 -> 属性类型」的映射表，将传递给内部的 NodeSchema、
 * SnippetSchema 以及嵌套的子组件，从而在整个组件定义中实现 props 的自动推导。
 */
export interface ComponentSchema<T extends ComponentPropsMap = DefaultComponentPropsMap> {
  /** 组件元数据信息 */
  meta: ComponentMeta
  /** 开始节点id */
  nodeId: string
  /**
   * 组件的 Schema 模板（NodeSchema），定义组件的渲染结构和默认配置。
   * 这是组件在页面树中的蓝图，渲染器根据它来创建组件实例。
   */
  nodes: { [key: string]: NodeSchema<T> }
  /** 组件支持的所有属性定义列表 */
  props?: PropDefinition[]
  /**
   * 组件触发的所有事件定义列表。
   *
   * 这是事件名的**唯一强类型来源**：事件流面板据此列出可绑定的事件，表达式编辑器
   * 据此补全 `event.<参数名>`。组件生命周期（挂载、卸载等）若需要被绑定，也在此声明为
   * 一个普通事件，不另设生命周期字段——否则同一件事会有两条互不相干的绑定路径。
   */
  events?: EventDefinition[]
  /** 组件的插槽定义列表 */
  slots?: SlotDefinition[]
  /** 组件的默认属性值映射表，键为属性名，值为默认值 */
  defaultProps?: Record<string, PropValue>
  /** 组件内部声明的子组件列表（可选），用于页面 schema 或组件 schema 解析时注册 */
  components?: ComponentSchema<T>[]
  /** 组件的预置代码片段列表（可选），用于快速创建组件实例 */
  snippets?: SnippetSchema<T>[]
  /**
   * 页面的数据源配置列表（可选）
   * 用于声明页面级别的数据获取和状态管理。
   */
  datasources?: DataSourceSchemaDef[]
  /**
   * 页面级声明式函数列表（可选）
   * 将自动注册到表达式引擎，供模板/条件/事件表达式使用，
   * 帮助在不写代码的前提下抽取重复逻辑（例如“进度拼接”、“邮箱校验”）。
   */
  functions?: FunctionSchema[]
  /** 编辑器的专有配置（可选），控制组件在编辑器中的交互行为 */
  // editorConfig?: EditorComponentConfig;
}
