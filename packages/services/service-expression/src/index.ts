import { definePlugin } from '@lc/kernel'
import type { ExpressionEngine } from '@lc/schema'
import { isExpressionString } from '@lc/schema'

const TEMPLATE_PATTERN = /\{\{([\s\S]*?)\}\}/g
const FULL_TEMPLATE_PATTERN = /^\s*\{\{([\s\S]*)\}\}\s*$/

/**
 * 去掉整段 `{{ ... }}` 包裹，只保留内部表达式。
 *
 * 模板插值（字符串中间混排）走 `interpolate`，这里只处理整值绑定，
 * 保证数字/布尔等类型不被强制转成字符串。
 */
function unwrapExpression(expression: string): string {
  const full = FULL_TEMPLATE_PATTERN.exec(expression)
  return full?.[1] ?? expression
}

interface CompiledExpression {
  /** 求值函数；scope 是渲染作用域（loop 变量、data 等） */
  run(scope: Record<string, unknown>): unknown
}

/**
 * 表达式服务插件。
 *
 * 使用 Function + with 提供低代码常见的「作用域内直接写变量名」体验。
 * 安全边界：表达式来自受信任的 schema，与物料代码同属 inline 执行位置；
 * 不可信插件/文档的隔离属于沙箱层（Part III），不在表达式引擎内解决。
 */
export default definePlugin({
  name: 'service-expression',
  provides: ['expression'],

  apply(ctx) {
    const cache = new Map<string, CompiledExpression | null>()

    function compile(expression: string): CompiledExpression | null {
      if (cache.has(expression)) return cache.get(expression) ?? null

      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('__scope', `with (__scope) { return (${expression}); }`) as (
          scope: Record<string, unknown>,
        ) => unknown
        const compiled: CompiledExpression = { run: (scope) => fn(scope) }
        cache.set(expression, compiled)
        return compiled
      } catch (error) {
        cache.set(expression, null)
        ctx.diagnostics.report(error, { scope: 'expression', expression })
        return null
      }
    }

    const engine: ExpressionEngine = {
      evaluate(expression, scope) {
        const compiled = compile(unwrapExpression(expression))
        if (!compiled) return undefined
        try {
          return compiled.run(scope)
        } catch (error) {
          ctx.diagnostics.report(error, { scope: 'expression', expression })
          return undefined
        }
      },

      interpolate(template, scope) {
        return template.replace(TEMPLATE_PATTERN, (_match, raw: string) => {
          const value = engine.evaluate(raw, scope)
          return value === undefined || value === null ? '' : String(value)
        })
      },

      isExpression: isExpressionString,
    }

    ctx.effect(() => ctx.provide('expression', engine, { apiVersion: '1.0' }))
  },
})
