/**
 * 属性（Props）架构定义
 * 本文件定义了组件属性的完整类型系统，涵盖：
 * - 属性类型（PropType）：支持字符串、数字、布尔、对象、数组、枚举等 15 种类型
 * - 枚举选项（PropOption）：用于 enum 类型的选择项定义
 * - 属性定义（PropDefinition）：组件属性的完整声明结构
 * - 属性值（PropValue）：属性在运行时可能持有的所有值类型的联合
 */

import type { ExpressionString, JsExpression } from './expression'

/**
 * 属性类型字面量联合
 * 定义了组件属性所有可能的数据类型。
 * 涵盖基本类型（string/number/boolean）、复合类型（object/array）、
 * UI 辅助类型（color/icon/style）以及特殊类型（event/slot/function）等。
 */
export type PropType =
  | 'string' // 字符串类型
  | 'number' // 数字类型
  | 'boolean' // 布尔类型
  | 'object' // 对象类型
  | 'array' // 数组类型
  | 'enum' // 枚举类型，需配合 options 字段提供可选值列表
  | 'event' // 事件类型（事件回调绑定）
  | 'slot' // 插槽类型（模板内容分发）
  | 'json' // JSON 类型（任意结构化数据）
  | 'color' // 颜色值类型（支持颜色选择器）
  | 'icon' // 图标类型（支持图标选择器）
  | 'style' // 样式对象类型
  | 'function' // 函数类型

/**
 * 枚举/选择类型属性的选项接口
 * 当 PropType 为 'enum' 时，通过此接口定义每个可选值项。
 */
export interface PropOption {
  /** 选项在编辑器中的显示标签 */
  label: string
  /** 选项的实际值，支持字符串、数字或布尔值 */
  value: string | number | boolean
}

/**
 * 组件属性定义接口
 * 声明一个组件所支持的某个属性的完整信息，
 * 包括名称、类型、默认值、校验规则和编辑器展示配置。
 */
export interface PropDefinition {
  /** 属性名称标识 */
  name: string
  /** 属性在编辑器中的显示标题 */
  title: string
  /** 属性的数据类型 */
  type: PropType
  /** 属性的默认值（可选），当未显式设置时使用此值 */
  defaultValue?: PropValue
  /** 属性是否为必填（可选），为 true 时编辑器会强制要求设置 */
  required?: boolean
  /** 属性描述说明（可选），用于编辑器中的属性提示 */
  description?: string
  /**
   * 是否允许在运行时设置此属性（可选）
   * 为 false 时，属性仅在设计时可用，运行时不可修改。
   */
  settable?: boolean
  /**
   * 是否支持表达式绑定（可选）
   * 为 true 时，属性值可以绑定为动态表达式（如 "{{ data.name }}"）。
   */
  bindable?: boolean
  /**
   * 枚举类型的选项列表（可选）
   * 当 type 为 'enum' 时必须提供，定义了下拉选择器的可选值。
   */
  options?: PropOption[]
  /**
   * 属性在编辑器属性面板中的分组名称（可选）
   * 用于将相关属性归类展示，提升编辑体验。
   */
  group?: string
  /**
   * 属性的条件显示表达式（可选）
   * 当表达式在运行时求值为 false 时，属性在编辑器中隐藏。
   * 用于实现"依赖于其他属性的条件属性"场景。
   */
  condition?: string
}

/**
 * 属性值联合类型
 * 定义了属性在运行时可能持有的所有值类型。
 * 除了 JavaScript 基本类型和复合类型外，
 * 还支持 ExpressionString（模板表达式）和 JsExpression（JS 表达式），
 * 使属性值可以是静态值，也可以是动态绑定的表达式。
 */
export type PropValue =
  | string // 字符串值
  | number // 数值
  | boolean // 布尔值
  | null // 空值
  | undefined // 未定义
  | PropValue[] // 递归的数组（支持嵌套）
  | { [key: string]: PropValue } // 递归的对象（支持嵌套）
  | ExpressionString // 模板表达式（动态绑定）
  | JsExpression // JS 表达式（动态逻辑）
