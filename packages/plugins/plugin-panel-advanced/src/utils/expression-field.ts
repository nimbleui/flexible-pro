import type { ExpressionString } from '@lc/schema'
import { createExpression, isExpressionString } from '@lc/schema'

/** `{{ ... }}` 模板外壳 */
const TEMPLATE_WRAP = /^\{\{([\s\S]*)\}\}$/

/**
 * 把输入框文本折成 `ExpressionString`。
 *
 * 存的是剥掉 `{{ }}` 外壳的内层文本，与文档里既有的条件表达式写法一致（宿主示例文档的
 * `condition` 就是这个形状）。引擎的 `compile` 两种写法都吃，但同一份文档只留一种，
 * 否则「同一个条件」会有两种可比对的形态，diff 与迁移都要多判一遍。
 *
 * @param text 输入框文本
 * @returns 表达式对象；空文本返回 `undefined`，由调用方删键而不是存一个永远为真的空表达式
 */
export function toExpression(text: string): ExpressionString | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined

  const inner = (TEMPLATE_WRAP.exec(trimmed)?.[1] ?? trimmed).trim()
  return inner === '' ? undefined : createExpression(inner)
}

/**
 * 把 schema 里的表达式还原成输入框文本。
 *
 * 统一带 `{{ }}` 显示，让用户在属性、动作条件与节点条件里看到的是同一种写法。
 * 裸字符串原样回显而不顺手包装：包装会把它从「恒为真的常量」变成「会求值的表达式」，
 * 那是语义变更，必须由用户显式提交才算数。
 */
export function fromExpression(value: unknown): string {
  if (isExpressionString(value)) return value.raw.trim() === '' ? '' : `{{ ${value.raw} }}`
  if (typeof value === 'string') return value
  return ''
}
