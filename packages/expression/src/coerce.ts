import { ExpressionError } from './errors'

/**
 * 表达式的值 coercion 规则。
 *
 * 单独成文件的原因：运算符求值、内置函数、模板插值三处都要用同一套转换，
 * 分叉过一次就会出现「插值把 null 当空串、`+` 把 null 当 0」这类无法解释的差别。
 */

/** 表达式在求值期间的可参与运算的值域 */
export type ExpressionValue = string | number | boolean | null | undefined | object

/**
 * 转成用于拼接与展示的字符串。
 *
 * 与 JS 的 `String(null)` 有意不同：`null` 与 `undefined` 转为空串。
 * 低代码里 `{{ count }} 项` 与 `count + ' 项'` 在数据未到位时期望得到「 项」，
 * 而不是「null 项」；插值已经是这个行为，运算符保持同一套语义。
 */
export function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return String(value)
}

/**
 * 按 JS 的 ToNumber 语义转换，但拒绝对象与数组。
 *
 * 拒绝的理由：`[] → 0`、`{} → NaN` 是 JS 的历史包袱，
 * 在白名单语言里让它抛错，比让它静默产出一个看起来像业务数字的 0 安全。
 *
 * @throws ExpressionError kind 为 `invalid-operand`
 */
export function toNumber(value: unknown, expression: string): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') return Number(value)
  if (value === null) return 0
  if (value === undefined) return Number.NaN

  throw new ExpressionError(
    'invalid-operand',
    `不能把 ${describeType(value)} 当成数字参与运算`,
    expression,
  )
}

/** 真值判定；采用 JS 语义，因此空数组与非空对象为真 */
export function toBoolean(value: unknown): boolean {
  return Boolean(value)
}

/** 空值判定：null、undefined、空串、空数组、无自有属性的对象 */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.length === 0
  if (Array.isArray(value)) return value.length === 0
  if (value instanceof Map || value instanceof Set) return value.size === 0
  if (isPlainRecord(value)) return Object.keys(value).length === 0
  return false
}

/** 空白判定：在空值之上，把只含空白符的字符串也算空 */
export function isBlankValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length === 0
  return isEmptyValue(value)
}

/** 只用于报错文案：给出一个用户能看懂的类型名 */
export function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return '数组'
  const type = typeof value
  if (type === 'object') return '对象'
  if (type === 'string') return '字符串'
  if (type === 'number') return '数字'
  if (type === 'boolean') return '布尔值'
  return type
}

/**
 * 判断是否为「可作为数据展开」的普通对象。
 *
 * 判据是原型为 Object.prototype 或 null，因此 Date、Map、自定义类实例
 * 都不算 —— `resolveValue` 递归时原样返回它们，避免把日期对象重建成普通对象。
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * 以自有数据属性的方式写入键。
 *
 * 不用 `target[key] = value`：当 key 是 `__proto__` 时赋值会命中
 * `Object.prototype` 上的 setter，直接把结果对象的原型换掉。
 * 这个键名在 `JSON.parse` 的载荷里真实存在（会产出一个自有 `__proto__` 数据属性），
 * 所以它不是假想场景，求值器与递归解析两处都必须走这里。
 */
export function defineDataProperty(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}
