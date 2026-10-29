/**
 * 表达式（Expression）架构定义
 * 本文件定义了 DSL 中两种表达式类型的结构和相关工具函数：
 * 1. ExpressionString —— 模板表达式字符串（如 "{{ user.name }}"），
 *    在运行时由表达式引擎解析求值。
 * 2. JsExpression —— 原生 JavaScript 表达式，直接执行。
 *
 * 表达式系统使得组件的属性、事件条件、循环数据源等
 * 可以动态绑定到运行时数据上下文中。
 */

/**
 * 模板表达式字符串接口
 * 表示一个使用双花括号语法包裹的动态表达式，如 "{{ user.name }}"。
 * 表达式在运行时由表达式引擎解析，从数据上下文中提取对应的值。
 */
export interface ExpressionString {
  /** 类型标识，固定为 'expression'，用于类型区分 */
  type: 'expression'
  /** 原始表达式字符串内容，如 "{{ user.name }}" */
  raw: string
  /**
   * 解析后的抽象语法树（AST）（可选）
   * 由表达式引擎在运行时填充，用于高效的表达式缓存和求值。
   * 调用者通常不需要关心此字段。
   */
  ast?: unknown
}

/**
 * 原生 JavaScript 表达式接口
 * 表示一段直接执行的 JavaScript 代码，提供更灵活的动态逻辑能力。
 * 与模板表达式不同，JS 表达式可以直接编写任意 JS 代码片段。
 */
export interface JsExpression {
  /** 类型标识，固定为 'js'，用于类型区分 */
  type: 'js'
  /** 可执行的 JavaScript 代码字符串 */
  code: string
}

/**
 * 类型守卫函数：判断一个未知值是否为 ExpressionString 类型
 * 通过检查值是否为非空对象、类型标识是否为 'expression'
 * 以及 raw 字段是否为字符串来进行判断。
 * 用于在运行时安全地处理动态表达式值。
 *
 * @param value - 要检测的未知类型值
 * @returns 如果值是 ExpressionString 类型则返回 true
 */
export function isExpressionString(value: unknown): value is ExpressionString {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ExpressionString).type === 'expression' &&
    typeof (value as ExpressionString).raw === 'string'
  )
}

/**
 * 类型守卫函数：判断一个未知值是否为 JsExpression 类型
 * 通过检查值是否为非空对象、类型标识是否为 'js'
 * 以及 code 字段是否为字符串来进行判断。
 *
 * @param value - 要检测的未知类型值
 * @returns 如果值是 JsExpression 类型则返回 true
 */
export function isJsExpression(value: unknown): value is JsExpression {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as JsExpression).type === 'js' &&
    typeof (value as JsExpression).code === 'string'
  )
}

/**
 * 创建模板表达式对象的工厂函数
 * 便捷地生成一个 ExpressionString 实例，避免手动构造对象。
 *
 * @param raw - 模板表达式字符串，如 "{{ user.name }}"
 * @returns 新创建的 ExpressionString 对象
 */
export function createExpression(raw: string): ExpressionString {
  return { type: 'expression', raw }
}

/**
 * 创建原生 JS 表达式对象的工厂函数
 * 便捷地生成一个 JsExpression 实例，避免手动构造对象。
 *
 * @param code - 可执行的 JavaScript 代码字符串
 * @returns 新创建的 JsExpression 对象
 */
export function createJsExpression(code: string): JsExpression {
  return { type: 'js', code }
}

/**
 * 表达式求值引擎的接口定义。
 * 注入到渲染器上下文中，用于在运行时对表达式求值和模板插值。
 */
export interface ExpressionEngine {
  /**
   * 对单个表达式字符串进行求值，返回原始结果（保留类型 — 数字、布尔值等）。
   * @param expr - 表达式字符串
   * @param scope - 求值作用域数据
   * @returns 求值结果，类型取决于表达式本身
   */
  evaluate(expr: string, scope: Record<string, unknown>): unknown

  /**
   * 对包含 `{{ ... }}` 插值标记的模板字符串进行插值，返回字符串结果。
   * 非字符串值会被强制转换为字符串。
   * @param template - 包含插值标记的模板
   * @param scope - 插值作用域数据
   * @returns 插值后的字符串
   */
  interpolate(template: string, scope: Record<string, unknown>): string

  /**
   * 判断某个值是否为需要求值的表达式引用。
   * @param value - 待检测的值
   * @returns 如果值是 ExpressionString 类型则返回 true
   */
  isExpression(value: unknown): value is ExpressionString
}
