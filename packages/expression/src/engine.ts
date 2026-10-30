import type { CompiledExpression, ExpressionEngine, ExpressionScope } from '@lc/schema'
import { isExpressionString, isJsExpression } from '@lc/schema'
import type { TemplateSegment } from './source'
import { splitTemplate, unwrapBraces } from './source'
import { createEvaluator } from './interpreter'
import { createFunctionRegistry } from './registry'
import { ExpressionError } from './errors'
import { parseExpressionSource } from './parser'
import { defineDataProperty, isPlainRecord } from './coerce'

/**
 * 表达式引擎装配。
 *
 * 这一层的职责是把「解析、求值、注册表、缓存」接成一个符合
 * `@lc/schema` 里 `ExpressionEngine` 契约的对象，本身不含语言规则。
 *
 * 缓存必须存在且必须有上限：设计器里用户是逐字符编辑表达式的，
 * 每个中间态都是一串唯一文本。无上限的 Map 在长会话里只会单调增长，
 * 这是把 `new Function` 换成解释器之后新引入的内存特征，不能不管。
 */

/** 编译缓存上限：一次设计会话里同时存活的不同表达式数量远低于这个量级 */
const DEFAULT_COMPILE_CACHE_LIMIT = 2000

/** 模板分段缓存上限 */
const DEFAULT_TEMPLATE_CACHE_LIMIT = 500

/**
 * 单次顶层求值的节点访问预算。
 *
 * 它是失控保护（`reduce` 里写死循环、函数互相递归），不是性能调优旋钮：
 * 正常业务表达式离这个量级差好几个数量级，触发了就说明表达式本身有问题。
 */
const DEFAULT_STEP_BUDGET = 100_000

/**
 * 单次顶层求值的时间预算。
 *
 * 取值依据：正常业务表达式远不到 1ms，1 万行的 `filter` 约 1~2ms，20ms 是十倍余量，
 * 同时它又小于「一帧」的量级，所以最坏情况是某个部件渲染为空而不是一页卡死。
 * 注意这是**按单次求值**计的：`interpolate` 的每一段、渲染树里每个表达式各有额度，
 * 整页的聚合耗时不在此约束范围内（那需要按帧配额，见档 2 的 Worker 方案）。
 */
const DEFAULT_TIME_BUDGET_MS = 20

/** 函数嵌套调用深度上限 */
const DEFAULT_CALL_DEPTH_LIMIT = 64

/** `resolveValue` 递归下降深度上限，兜住自引用的 schema 结构 */
const DEFAULT_RESOLVE_DEPTH_LIMIT = 32

/** 诊断上报通道，与内核 `ctx.diagnostics.report` 同形 */
export type ExpressionDiagnosticSink = (error: unknown, detail: Record<string, unknown>) => void

export interface ExpressionEngineOptions {
  /**
   * `JsExpression` 的执行器。
   *
   * 引擎核心**不自己持有 `new Function`**：这样整个仓库里「把字符串变成可执行代码」
   * 的位置只有一处，可以通过搜索直接审计，也符合 CSP 禁 `unsafe-eval` 的运行时要求。
   * 不传本参数时，任何 `JsExpression` 都会被拒绝并上报诊断 ——
   * 「能力开关」就是这个参数本身，不需要再配一个布尔位。
   */
  jsRunner?: (code: string, scope: ExpressionScope) => unknown

  /** 诊断上报通道 @default 空实现（诊断属于宿主，不属于语言） */
  onDiagnostic?: ExpressionDiagnosticSink

  /** 编译缓存条目上限 @default 2000 */
  compileCacheLimit?: number

  /** 模板分段缓存条目上限 @default 500 */
  templateCacheLimit?: number

  /** 单次顶层求值节点访问预算 @default 100000 */
  stepBudget?: number

  /**
   * 单次顶层求值的时间预算（毫秒）@default 20；传 `Infinity` 关闭。
   *
   * 补的是步数预算兜不住的一类：一次原生方法或宿主函数调用在语法树上只占一个节点。
   * 已经在执行中的调用无法被中断，只能在其返回后中止后续求值 —— 这条限制是
   * 同 realm 执行的固有属性，要真正隔离得走 Worker。
   */
  timeBudgetMs?: number

  /** 单调时钟注入点 @default performance.now */
  now?: () => number

  /** 函数嵌套调用深度上限 @default 64 */
  callDepthLimit?: number

  /** `resolveValue` 递归深度上限 @default 32 */
  resolveDepthLimit?: number
}

/** 模板的一个已编译分段；`compiled` 为 null 表示该段语法非法、已按文本记入负缓存 */
type CompiledSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'expression'; readonly compiled: CompiledExpression | null }

/**
 * 创建表达式引擎。
 *
 * @param options 能力开关与预算配置
 * @returns 满足 `ExpressionEngine` 契约的实例；同一进程内可以有多个实例
 *   （预览沙箱、FlowRunner 各自持有独立注册表与缓存），因此不注册全局单例
 */
export function createExpressionEngine(
  options: ExpressionEngineOptions = {},
): ExpressionEngine {
  const report: ExpressionDiagnosticSink = options.onDiagnostic ?? (() => {})
  const compileCacheLimit = options.compileCacheLimit ?? DEFAULT_COMPILE_CACHE_LIMIT
  const templateCacheLimit = options.templateCacheLimit ?? DEFAULT_TEMPLATE_CACHE_LIMIT
  const stepBudget = options.stepBudget ?? DEFAULT_STEP_BUDGET
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS
  const callDepthLimit = options.callDepthLimit ?? DEFAULT_CALL_DEPTH_LIMIT
  const resolveDepthLimit = options.resolveDepthLimit ?? DEFAULT_RESOLVE_DEPTH_LIMIT

  const { registry: functions, resolve } = createFunctionRegistry(report)
  const evaluator = createEvaluator({
    stepBudget,
    timeBudgetMs,
    callDepthLimit,
    now: options.now ?? (() => performance.now()),
    resolveFunction: resolve,
    onUnboundIdentifier: (name, source) =>
      reportOnce(
        `${source}#${name}`,
        source,
        new ExpressionError('unbound-identifier', `${name} 不在作用域里`, source),
      ),
  })

  const compileCache = new Map<string, CompiledExpression>()
  const templateCache = new Map<string, CompiledSegment[]>()

  /** Map 保持插入顺序，删掉第一个键就是淘汰最旧的一条 */
  function cacheSet<V>(cache: Map<string, V>, limit: number, key: string, value: V): void {
    if (cache.size >= limit) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(key, value)
  }

  /**
   * 语法错误按文本去重上报。
   *
   * 语法错误与作用域无关，同一串非法文本在每次渲染都报一次只会把诊断面板刷满，
   * 让真正需要看的一次性错误（运行期、注册失败）被淹掉。
   * 运行期错误**不去重**：同一串文本在不同作用域下是不同问题。
   *
   * @param dedupeKey 去重键，与展示用的表达式文本分开，避免键本身混进诊断详情
   */
  const reportedSyntax = new Set<string>()

  function reportOnce(dedupeKey: string, source: string, error: unknown): void {
    if (reportedSyntax.has(dedupeKey)) return
    if (reportedSyntax.size >= compileCacheLimit) reportedSyntax.clear()
    reportedSyntax.add(dedupeKey)
    report(error, { scope: 'expression', expression: source })
  }

  function compile(expr: string): CompiledExpression {
    const source = unwrapBraces(expr)
    const cached = compileCache.get(source)
    if (cached) return cached

    const ast = parseExpressionSource(source)
    const compiled: CompiledExpression = {
      source,
      ast,
      evaluate: (scope) => evaluator.run(ast, scope, source),
    }
    cacheSet(compileCache, compileCacheLimit, source, compiled)
    return compiled
  }

  /** 引擎顶层入口的统一错误策略：吞掉异常、上报诊断、返回 undefined */
  function evaluateCompiledSilently(
    compiled: CompiledExpression,
    scope: ExpressionScope,
  ): unknown {
    try {
      return compiled.evaluate(scope)
    } catch (error) {
      report(error, { scope: 'expression', expression: compiled.source })
      return undefined
    }
  }

  function evaluate(expr: string, scope: ExpressionScope): unknown {
    let compiled: CompiledExpression
    try {
      compiled = compile(expr)
    } catch (error) {
      reportOnce(expr, expr, error)
      return undefined
    }
    return evaluateCompiledSilently(compiled, scope)
  }

  /**
   * 模板分段。
   *
   * 非法表达式会被缓存成 `compiled: null` 而不是每次重解析：一个写坏的模板
   * 在每次渲染都抛语法错误、每次都重跑解析，比留一条负缓存更费。
   */
  function compileTemplate(template: string): CompiledSegment[] {
    const cached = templateCache.get(template)
    if (cached) return cached

    const segments: CompiledSegment[] = splitTemplate(template).map(
      (segment: TemplateSegment) => {
        if (segment.kind === 'text') return { kind: 'text', text: segment.text }

        try {
          return { kind: 'expression', compiled: compile(segment.text) }
        } catch (error) {
          reportOnce(segment.text, segment.text, error)
          return { kind: 'expression', compiled: null }
        }
      },
    )
    cacheSet(templateCache, templateCacheLimit, template, segments)
    return segments
  }

  function interpolate(template: string, scope: ExpressionScope): string {
    let result = ''

    for (const segment of compileTemplate(template)) {
      if (segment.kind === 'text') {
        result += segment.text
        continue
      }
      if (!segment.compiled) continue

      const value = evaluateCompiledSilently(segment.compiled, scope)
      result += value === null || value === undefined ? '' : String(value)
    }

    return result
  }

  function resolveJs(code: string, scope: ExpressionScope): unknown {
    if (!options.jsRunner) {
      reportOnce(
        code,
        code,
        new ExpressionError(
          'js-disabled',
          '当前引擎未开启 JsExpression 执行能力，请改用白名单表达式',
          code,
        ),
      )
      return undefined
    }

    try {
      return options.jsRunner(code, scope)
    } catch (error) {
      report(error, { scope: 'expression', expression: code })
      return undefined
    }
  }

  function resolveAt(value: unknown, scope: ExpressionScope, depth: number): unknown {
    if (depth > resolveDepthLimit) {
      report(new ExpressionError('depth', 'schema 值嵌套层数超过上限，该子树原样返回', ''), {
        scope: 'expression',
        stage: 'resolveValue',
        depth,
      })
      return value
    }

    if (isExpressionString(value)) return evaluate(value.raw, scope)
    if (isJsExpression(value)) return resolveJs(value.code, scope)

    if (typeof value === 'string') {
      return value.includes('{{') ? interpolate(value, scope) : value
    }

    if (Array.isArray(value)) {
      return value.map((item) => resolveAt(item, scope, depth + 1))
    }

    // 只对普通对象递归：Date、Map 与自定义类实例原样透传，
    // 否则一个日期字段会被重建成 { }，把 bug 藏进渲染层
    if (isPlainRecord(value)) {
      const resolved: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        defineDataProperty(resolved, key, resolveAt(item, scope, depth + 1))
      }
      return resolved
    }

    return value
  }

  return {
    evaluate,
    interpolate,
    isExpression: isExpressionString,
    compile,
    resolveValue: (value, scope) => resolveAt(value, scope, 0),
    functions,
  }
}
