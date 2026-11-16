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
 *
 * `JsExpression` 的编译缓存也归这一层：它的条目是编译后的函数体，比语法树更重，
 * 交给装配层各自决定「缓存或不缓存」只会让三处缓存的淘汰口径各走各路。
 */

/** 编译缓存上限：一次设计会话里同时存活的不同表达式数量远低于这个量级 */
const DEFAULT_COMPILE_CACHE_LIMIT = 2000

/** 模板分段缓存上限 */
const DEFAULT_TEMPLATE_CACHE_LIMIT = 500

/**
 * `JsExpression` 编译缓存上限。
 *
 * 比语法树缓存小一个量级：JS 表达式是逃生门，一个页面里的数量本就少，
 * 这个上限的存在理由是把最坏情况封顶，而不是被人调优。
 */
const DEFAULT_JS_CACHE_LIMIT = 500

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

/**
 * `JsExpression` 的编译产物：吃一次作用域、返回结果。
 *
 * 抛错由引擎吞掉并转成诊断，编译器本身不需要 try。
 */
export type JsExpressionRunner = (scope: ExpressionScope) => unknown

/**
 * 引擎装配配置。
 *
 * 所有预算参数按「单个引擎实例」计，而非全局：预览沙箱、动作执行器等
 * 可以各自持有一份额度独立的实例。缺省值统一取模块顶部的 DEFAULT_* 常量。
 */
export interface ExpressionEngineOptions {
  /**
   * `JsExpression` 的编译器：把代码文本变成可执行函数。
   *
   * 引擎核心**不自己持有 `new Function`**：这样整个仓库里「把字符串变成可执行代码」
   * 的位置只有一处，可以通过搜索直接审计，也符合 CSP 禁 `unsafe-eval` 的运行时要求。
   * 不传本参数时，任何 `JsExpression` 都会被拒绝并上报诊断 ——
   * 「能力开关」就是这个参数本身，不需要再配一个布尔位。
   *
   * 编译与执行分成两步（而不是一个 `run(code, scope)`）有两个理由：编译结果由引擎
   * 按 `jsCacheLimit` 统一缓存，与语法树、模板分段共用同一套淘汰口径；执行则被纳入
   * `timeBudgetMs` 的计量范围 —— 代价是每次调用都调一次时钟，收益是「配了预算却
   * 一条 JS 都没管」这种静默失效不再可能。
   */
  compileJs?: (code: string) => JsExpressionRunner

  /** 诊断上报通道 @default 空实现（诊断属于宿主，不属于语言） */
  onDiagnostic?: ExpressionDiagnosticSink

  /** 编译缓存条目上限 @default 2000 */
  compileCacheLimit?: number

  /** 模板分段缓存条目上限 @default 500 */
  templateCacheLimit?: number

  /** `JsExpression` 编译缓存条目上限 @default 500 */
  jsCacheLimit?: number

  /** 单次顶层求值节点访问预算 @default 100000 */
  stepBudget?: number

  /**
   * 单次顶层求值的时间预算（毫秒）@default 20；传 `Infinity` 关闭。
   *
   * 补的是步数预算兜不住的一类：一次原生方法或宿主函数调用在语法树上只占一个节点。
   * 已经在执行中的调用无法被中断，只能在其返回后中止后续求值 —— 这条限制是
   * 同 realm 执行的固有属性，要真正隔离得走 Worker。
   *
   * `JsExpression` 整段代码就是「一次执行中的调用」，因此对它而言本参数只能
   * **事后计量并上报 `timeout`**，结果照常返回；要真的把跑飞的求值停下来，
   * 只有沙箱旁路（`sandbox/client.ts` 的 `terminate()`）做得到。
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
  /** 静态文本段，插值时原样拼接 */
  | {
      readonly kind: 'text'
      /** 参与拼接的原文，保留模板边界之间的空白 */
      readonly text: string
    }
  /** 表达式段，插值时求值并字符串化 */
  | {
      readonly kind: 'expression'
      /** 编译产物；null 是「解析失败」的负缓存标记，重渲染不再重复解析 */
      readonly compiled: CompiledExpression | null
    }

/**
 * 创建表达式引擎。
 *
 * @param options 能力开关与预算配置
 * @returns 满足 `ExpressionEngine` 契约的实例；同一进程内可以有多个实例
 *   （预览沙箱、动作执行器各自持有独立注册表与缓存），因此不注册全局单例
 */
export function createExpressionEngine(
  options: ExpressionEngineOptions = {},
): ExpressionEngine {
  const report: ExpressionDiagnosticSink = options.onDiagnostic ?? (() => {})
  const compileCacheLimit = options.compileCacheLimit ?? DEFAULT_COMPILE_CACHE_LIMIT
  const templateCacheLimit = options.templateCacheLimit ?? DEFAULT_TEMPLATE_CACHE_LIMIT
  const jsCacheLimit = options.jsCacheLimit ?? DEFAULT_JS_CACHE_LIMIT
  const stepBudget = options.stepBudget ?? DEFAULT_STEP_BUDGET
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS
  const callDepthLimit = options.callDepthLimit ?? DEFAULT_CALL_DEPTH_LIMIT
  const resolveDepthLimit = options.resolveDepthLimit ?? DEFAULT_RESOLVE_DEPTH_LIMIT

  // 同一个时钟喂给解释器与 JS 执行计量：两处预算必须是同一把尺子，否则
  // 「timeBudgetMs 到底按谁的读数判定」会变成第三处口径
  const now = options.now ?? (() => performance.now())

  const { registry: functions, resolve } = createFunctionRegistry(report)
  const evaluator = createEvaluator({
    stepBudget,
    timeBudgetMs,
    callDepthLimit,
    now,
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
  const jsCache = new Map<string, JsExpressionRunner>()

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

  /**
   * `JsExpression` 的求值入口。
   *
   * 三段：能力判定 → 编译（带缓存）→ 执行（带时间计量）。编译失败与执行抛错
   * 都收敛成「返回 undefined + 一条诊断」，与白名单路径同一套降级策略，
   * 否则一个坏掉的 JS 字段会把整棵渲染树带崩。
   *
   * 编译失败不入缓存，这一点和语法树的负缓存策略不同：坏代码每次渲染重编译、
   * 每次各报一条诊断，换来的是不必再定「负缓存何时失效」。这条路径默认关闭，
   * 只在显式开启 `allowUnsafeJs` 的宿主里可达，先不为它加一层状态。
   */
  function resolveJs(code: string, scope: ExpressionScope): unknown {
    // 局部名与选项同名：这里不能叫 compile，本作用域已有一个编译语法树的 compile
    const compileJs = options.compileJs
    if (!compileJs) {
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

    let run = jsCache.get(code)
    if (run === undefined) {
      try {
        run = compileJs(code)
      } catch (error) {
        report(error, { scope: 'expression', expression: code, stage: 'js-compile' })
        return undefined
      }
      cacheSet(jsCache, jsCacheLimit, code, run)
    }

    const startedAt = now()
    try {
      const value = run(scope)
      reportJsOverrun(code, now() - startedAt)
      return value
    } catch (error) {
      report(error, { scope: 'expression', expression: code })
      return undefined
    }
  }

  /**
   * JS 执行超预算的事后上报。
   *
   * 同 realm 的原生调用中断不了，所以这条路径上报而不中止：至少让「一个 JS 字段
   * 每帧吃掉 200ms」在诊断面板里可见，而不是配了 `timeBudgetMs` 却静默无效。
   * 报的是和白名单路径同一个 `timeout` 分类，两条路径的超预算能在面板里一起排序。
   *
   * 只在执行成功的路径上计量：抛错时原始错误比耗时更重要，理由与
   * `interpreter.ts` 里 `withCallDepth` 的检查点一致。
   */
  function reportJsOverrun(code: string, elapsedMs: number): void {
    if (elapsedMs <= timeBudgetMs) return

    report(
      new ExpressionError(
        'timeout',
        `JsExpression 求值耗时 ${elapsedMs.toFixed(1)}ms，超过 ${timeBudgetMs}ms 时间预算；同 realm 不中止，需中止请走沙箱旁路`,
        code,
      ),
      { scope: 'expression', expression: code, stage: 'js-runner' },
    )
  }

  /**
   * 递归重建普通对象的一层。
   *
   * 用 `defineDataProperty` 逐键定义而不是 spread：保持与求值器对象字面量同一
   * 组装口径，产出永远是仅含自有数据属性的普通对象。
   */
  function resolvePlainRecord(
    value: Record<string, unknown>,
    scope: ExpressionScope,
    depth: number,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      defineDataProperty(resolved, key, resolveAt(item, scope, depth + 1))
    }
    return resolved
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
    if (isPlainRecord(value)) return resolvePlainRecord(value, scope, depth)

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
