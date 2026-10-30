/**
 * 表达式错误类型。
 *
 * 用「一个类 + kind 判别」而不是错误类继承树：消费方需要的是分类处理
 * （安全类错误要在控制台突出、语法类错误要能定位到输入框），
 * 而继承树会让 `instanceof` 判断随类的增加变得含糊。
 * 跨包场景下（运行时可能加载到两份 @lc/expression 副本）`instanceof` 不可靠，
 * 因此判定用 `name` 字段，见 `isExpressionError`。
 */

/** 表达式失败的分类 */
export type ExpressionErrorKind =
  /** 文本不符合语法 */
  | 'syntax'
  /** 函数注册被拒绝：名字非法、与内置重名、缺名字 */
  | 'invalid-registration'
  /** 访问了被禁止的属性（原型链相关键） */
  | 'forbidden-property'
  /** 调用了不存在的函数 */
  | 'unknown-function'
  /** 作用域里没有这个名字（只警告，求值结果仍是 undefined） */
  | 'unbound-identifier'
  /** 把非函数值当函数调用 */
  | 'not-a-function'
  /** 操作数类型不参与该运算 */
  | 'invalid-operand'
  /** 求值步数超限，用于兜住死循环与无限递归 */
  | 'budget'
  /** 单次求值耗时超过时间预算，用于兜住单个昂贵的外部调用 */
  | 'timeout'
  /** 递归深度超限：函数嵌套调用，或 `resolveValue` 的 schema 值层数 */
  | 'depth'
  /** schema 值使用了未开启的 `JsExpression` */
  | 'js-disabled'
  /** 引擎内部未预期的异常；不是表达式本身的问题 */
  | 'internal'

/** 表达式求值或解析失败的错误。 */
export class ExpressionError extends Error {
  /** 失败分类 */
  readonly kind: ExpressionErrorKind
  /** 出错时所处的表达式文本 */
  readonly expression: string
  /** 语法错误的源码偏移量；运行期错误为 undefined */
  readonly offset: number | undefined

  constructor(kind: ExpressionErrorKind, message: string, expression: string, offset?: number) {
    super(`${message}（${kind}）`)
    this.name = 'ExpressionError'
    this.kind = kind
    this.expression = expression
    this.offset = offset
  }
}

/**
 * 判断未知错误是否为表达式错误。
 *
 * 走 `name` 而不是 `instanceof`：原因见文件头注释。
 */
export function isExpressionError(value: unknown): value is ExpressionError {
  return value instanceof Error && value.name === 'ExpressionError'
}
