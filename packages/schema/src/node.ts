/**
 * 节点（Node）架构定义
 * 本文件定义了组件树的核心构建单元 —— NodeSchema。
 * 在 DSL 中，每个组件实例在页面树中都以一个 NodeSchema 节点表示。
 * 节点支持：
 * - 属性绑定（props）
 * - 子节点嵌套（children）
 * - 插槽分发（slots）
 * - 事件绑定（events）
 * - 指令系统（directives）：条件显示/隐藏/禁用等
 * - 条件渲染（condition）
 * - 循环渲染（loop）
 * - 样式与类名（style / className）
 */

import type { EventChain, EventHandlerDef } from './events'
import type { ExpressionString } from './expression'
import type { PropValue } from './props'
import type { StyleSchema, LayoutSchema } from './styles'

/**
 * 指令定义接口
 * 指令是挂载到节点上的声明式行为，影响节点的渲染和交互状态。
 * 通过表达式条件来决定是否应用该指令。
 * 类似于 Vue 的 v-show、v-if 或 Angular 的结构型指令。
 */
export interface Directive {
  /**
   * 指令类型：
   * - 'show': 根据条件显示/隐藏（CSS display 控制，DOM 保留）
   * - 'hide': 与 'show' 相反，条件为真时隐藏
   * - 'disabled': 根据条件禁用组件交互
   * - 'readonly': 根据条件设置组件为只读状态
   * - 'required': 根据条件设置组件为必填状态
   */
  type: 'show' | 'hide' | 'disabled' | 'readonly' | 'required'
  /** 指令生效的条件表达式，只有表达式求值为真时指令才生效 */
  condition: ExpressionString
}

/**
 * 循环渲染配置接口
 * 定义节点的循环渲染行为，类似于 Vue 的 v-for 或 React 的 Array.map()。
 * 节点将根据数据源中的每一项重复渲染，每次迭代都可访问当前项数据。
 */
export interface LoopConfig {
  /**
   * 循环的数据源表达式
   * 指向一个数组类型的上下文数据，如 "{{ user.list }}"。
   * 运行时表达式引擎解析后应返回一个可迭代的数组。
   */
  dataSource: ExpressionString
  /** 循环体中当前项的名称，如 "item"，在子节点中可通过此名称访问当前项, 默认为 "$item" */
  itemName?: string
  /** 循环体中当前索引的名称（可选），如 "index"，默认为 "$index" */
  indexName?: string
  /**
   * 用于优化渲染的键值表达式（可选）
   * 类似于 Vue 的 :key 或 React 的 key 属性，
   * 帮助运行时框架追踪每个循环项的身份，提升 diff 性能。
   */
  key?: string
}

/**
 * 事件绑定值联合类型
 * 节点事件映射表中每个事件名对应值支持两种形式：
 * 1. EventHandlerDef[] —— 简单处理器列表（向后兼容的默认模式）
 * 2. EventChain —— 事件处理链（支持多步骤、分支、并行等复杂流程）
 */
export type EventBindingValue = EventHandlerDef[] | EventChain

/**
 * 组件属性映射表
 * 描述「组件名 -> 该组件的属性类型」的映射关系，
 * 作为 NodeSchema 的泛型参数，用于根据 componentName 自动推导 props 的类型。
 *
 * 值约束取 `object` 而不是 `Record<string, unknown>`：后者会把用 `interface`
 * 声明的 props 类型挡在门外（接口没有隐式索引签名），而 `any` 等于放弃约束。
 * 属性形状本身由 `NodeProps<T[K]>` 逐键展开，这里不需要再限定值类型。
 *
 * 例如：
 * ```ts
 * type AppComponents = {
 *   Badge: { value: string | number; max: string | number; dot?: boolean };
 *   Button: { text: string; disabled?: boolean };
 * };
 * ```
 */
export type ComponentPropsMap = Record<string, object>

/**
 * NodeSchema 默认使用的组件属性映射表
 * 当不显式传入组件映射表时的回退类型：componentName 为任意字符串，
 * props 为 `Record<string, PropValue>`，用于与历史宽松用法保持兼容。
 * NodeSchema、ComponentSchema、PageSchema 共享此默认值，以保证默认行为一致。
 */
export type DefaultComponentPropsMap = Record<string, Record<string, PropValue>>

/**
 * 节点属性输入类型
 * 将组件属性 P 的每个字段转换为「可选」且「支持静态值或表达式绑定」的形式。
 * 即每个属性既可以直接写静态值，也可以写成 ExpressionString 进行动态绑定。
 */
export type NodeProps<P> = {
  [K in keyof P]?: P[K] | ExpressionString
}

/**
 * 节点架构基础接口
 * 抽取 NodeSchema 中与具体组件无关的通用字段。
 * componentName 与 props 由泛型 NodeSchema 根据组件映射表补充，
 * 从而实现「写 componentName 即可自动推导 props」的能力。
 */
export interface NodeSchemaBase {
  /** 节点唯一标识 ID，在整个页面范围内唯一 */
  id: string
  /**
   * 子节点列表（可选）
   * 形成组件树的层级结构。对于容器型组件（如 Container、Form），
   * 子节点会被渲染在组件内部的默认区域。
   */
  children?: string[]
  /**
   * 具名插槽内容（可选）
   * 键为插槽名称，值为该插槽中的子节点列表。
   * 用于组件的内容分发，类似于 Vue 的具名插槽或 React 的 children prop。
   */
  slots?: Record<string, string[]>
  /**
   * 事件绑定映射表（可选）
   * 键为事件名称（如 'click'），值为该事件的绑定配置。
   *
   * 支持两种绑定形式：
   * - EventHandlerDef[]：简单处理器列表，按顺序依次执行（向后兼容）
   * - EventChain：事件处理链，支持多步骤、条件分支、并行执行
   *
   * 当节点触发指定事件时，运行时根据绑定类型执行相应逻辑。
   */
  events?: Record<string, EventBindingValue>
  /** 节点上应用的条件指令列表（可选），按数组顺序依次评估 */
  directives?: Directive[]
  /**
   * 条件渲染表达式（可选）
   * 当表达式求值为 true 时渲染节点，为 false 时从 DOM 中移除。
   * 不同于 show/hide 指令，条件渲染会销毁/重建组件实例。
   */
  condition?: ExpressionString
  /** 循环渲染配置（可选），配置后节点将根据数据源重复渲染 */
  loop?: LoopConfig
  /**
   * 节点的唯一键值（可选）
   * 用于渲染优化，帮助框架追踪节点身份以复用 DOM 元素。
   * 在循环渲染中尤其重要。
   */
  key?: string
  /** 节点的内联样式配置（可选） */
  style?: StyleSchema
  /**
   * 节点的画布布局配置（可选）
   * 描述节点在编辑器画布中的定位方式（flow / absolute）与几何信息，
   * 属于设计态数据。注意它指"节点自身如何被放置"，与容器组件 props 中的
   * 自动布局能力（子项如何排布）是不同概念。运行时由渲染器编译为对应 CSS。
   */
  layout?: LayoutSchema
  /** 节点的 CSS 类名字符串（可选），可包含多个用空格分隔的类名 */
  className?: string
  /** 图层树显示名（可选）；缺省显示 componentName */
  name?: string
  /**
   * 是否隐藏（可选）。
   *
   * 隐藏节点不渲染、不参与画布命中，但仍保留在 schema 与图层树中；
   * 与 `directives` 的运行时显隐不同，它属于设计态开关。
   *
   * @default false
   */
  hidden?: boolean
  /**
   * 是否锁定（可选）。
   *
   * 锁定节点在画布上不可点选、不可框选、不参与变换命令，但可通过图层树选中。
   *
   * @default false
   */
  locked?: boolean
}

/**
 * 节点架构类型
 * NodeSchema 是整个 DSL 中最核心的数据结构。
 * 它代表组件树中的一个组件实例，包含了该实例的全部配置信息。
 * 节点通过 children 形成树状结构，通过 slots 支持命名内容分发。
 *
 * 泛型参数 T 是「组件名 -> 属性类型」的映射表（{@link ComponentPropsMap}）。
 * 传入后，NodeSchema 会展开为一个可辨识联合（discriminated union）：
 * - 当 componentName 命中映射表中的某个组件名时，props 会被自动推导为该组件对应的属性类型；
 * - 当 componentName 不在映射表中（未登记的组件）时，回退为宽松的
 *   `Record<string, PropValue>`，从而允许任意属性。
 *
 * 借助 `string & {}` 的字面量联合技巧，已登记的组件名仍可获得自动补全与类型推导，
 * 同时不限制使用未登记的组件名。
 *
 * 例如：
 * ```ts
 * type AppComponents = {
 *   Badge: { value: string | number; max: string | number };
 * }
 *
 * const node: NodeSchema<AppComponents> = {
 *   id: 'n1',
 *   componentName: 'Badge', // 命中映射表
 *   props: { value: 5, max: 99 }, // props 自动推导为 Badge 的属性
 * };
 *
 * const unknown: NodeSchema<AppComponents> = {
 *   id: 'n2',
 *   componentName: 'CustomWidget', // 未登记的组件名
 *   props: { foo: 'bar' }, // 回退为 Record<string, PropValue>
 * };
 * ```
 *
 * 不传泛型时退化为宽松模式：componentName 为任意字符串，
 * props 为 `Record<string, PropValue>`，与历史用法保持兼容。
 */
export type NodeSchema<T extends ComponentPropsMap = DefaultComponentPropsMap> =
  | {
      [K in keyof T]: NodeSchemaBase & {
        /** 节点对应的组件名称，用于查找组件定义和执行渲染 */
        componentName: K
        /** 节点的属性配置，键为属性名，值为属性值（支持静态值和表达式） */
        props?: NodeProps<T[K]>
      }
    }[keyof T]
  | (NodeSchemaBase & {
      /**
       * 未在映射表 T 中登记的组件名称。
       * 使用 `string & {}` 保留已登记组件名的字面量自动补全，同时允许任意字符串。
       */
      componentName: string & {}
      /** 未登记组件的属性配置，回退为宽松的 `Record<string, PropValue>` */
      props?: Record<string, PropValue>
    })
