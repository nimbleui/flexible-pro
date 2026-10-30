import { definePlugin } from '@lc/kernel'
import type { ExpressionScope } from '@lc/schema'
import { createExpressionEngine } from '@lc/expression'

/**
 * 表达式服务插件。
 *
 * 语言实现全部在 `@lc/expression`；本文件只做三件事：
 * 读取配置、将诊断接到内核 `ctx.diagnostics`、把引擎注册成 `expression` 服务。
 * 分成两层的原因是运行时播放器不需要插件内核也能求值。
 */

/** 表达式服务配置 */
export interface ExpressionServiceConfig {
  /**
   * 是否允许执行 schema 里的 `JsExpression`。
   *
   * 开启等于引入 `unsafe-eval`：该求值路径要求 CSP 允许 `unsafe-eval`，
   * 因此默认关闭。关闭时 `JsExpression` 被拒绝并上报一条诊断，
   * 白名单表达式不受影响。
   *
   * @default false
   */
  allowUnsafeJs: boolean

  /**
   * 单次求值的时间预算（毫秒）。省略时用 `@lc/expression` 的默认值。
   *
   * 调大它的正当理由只有一个：某个表达式确实要处理超大数据集。
   * 它挡的是「一个坏表达式拖垮画布帧率」，不是恶意代码隔离 —— 后者需要 Worker。
   */
  timeBudgetMs?: number
}

/**
 * `JsExpression` 执行器。
 *
 * 这是整个仓库唯一「把字符串变成可执行代码」的位置，刻意留在装配层而不是引擎核心：
 * 审计时只需搜这一处，而 `@lc/expression` 可以声明自己完全不需要 `unsafe-eval`。
 *
 * 用 `with (scope)` 是为了保住 schema 里既有的书写习惯（`{{ count + 1 }}` 直接引用
 * 变量名而不是 `{{ data.count + 1 }}`）；这条路径本身就声明为不受沙箱保护，
 * 与物料代码同属 inline 执行位置，可信度判断在 §19.2 的信任分级里，不在这里。
 */
function createJsRunner(): (code: string, scope: ExpressionScope) => unknown {
  const cache = new Map<string, (scope: ExpressionScope) => unknown>()

  return (code, scope) => {
    let run = cache.get(code)
    if (!run) {
      const compiled = new Function('scope', `with (scope) { return (${code}); }`) as (
        scope: ExpressionScope,
      ) => unknown
      cache.set(code, compiled)
      run = compiled
    }
    return run(scope)
  }
}

export default definePlugin<ExpressionServiceConfig>({
  name: 'service-expression',
  provides: ['expression'],

  schema: {
    parse: (input) => {
      const raw = input as Partial<ExpressionServiceConfig> | undefined
      const timeBudgetMs = raw?.timeBudgetMs
      if (timeBudgetMs !== undefined && (Number.isNaN(timeBudgetMs) || timeBudgetMs < 0)) {
        throw new TypeError(
          `[lc] service-expression: timeBudgetMs 必须是非负数或 Infinity，实际为 ${String(timeBudgetMs)}`,
        )
      }

      return { allowUnsafeJs: Boolean(raw?.allowUnsafeJs), timeBudgetMs }
    },
  },

  apply(ctx, config) {
    const engine = createExpressionEngine({
      jsRunner: config.allowUnsafeJs ? createJsRunner() : undefined,
      timeBudgetMs: config.timeBudgetMs,
      onDiagnostic: (error, detail) => ctx.diagnostics.report(error, detail),
    })

    ctx.effect(() => ctx.provide('expression', engine, { apiVersion: '1.1' }))
  },
})
