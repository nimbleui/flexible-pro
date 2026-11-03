import type {
  ExpressionBinaryOp,
  ExpressionCallNode,
  ExpressionNode,
  ExpressionScope,
} from '@lc/schema'
import type { ResolvedFunction } from './registry'
import { ExpressionError } from './errors'
import {
  defineDataProperty,
  describeType,
  toBoolean,
  toDisplayString,
  toNumber,
} from './coerce'
import { FORBIDDEN_KEYS, resolveMethodTable } from './host'

/**
 * 白名单求值器。
 *
 * 三条不可让的规矩，对应设计文档 §19.8「表达式引擎白名单函数，禁止原型链访问、
 * 禁止 constructor」：
 * 1. 属性读取只认 `Object.hasOwn`，永不沿原型链查找，`FORBIDDEN_KEYS` 再兜一层。
 * 2. 方法调用先查按接收者类型划分的白名单表，表外再退回「自有函数属性」，
 *    所以 `list.filter` 走表、`api.send()` 走宿主注入的函数值，
 *    而 `str.constructor` 两条路都到不了。
 * 3. 每次顶层求值有步数预算、函数调用有深度预算，兜住 `reduce` 里的死循环与互相递归。
 *
 * 代价要写清楚：Date、Map、Set 与自定义类实例的成员访问会失败，
 * 因为它们的方法都在原型上。需要这些能力时由宿主把函数放进求值作用域。
 */

/** 一层作用域。用帧数组而不是原型链做作用域嵌套，正是为了不借用 JS 的查找机制 */
interface Frame {
  /** 本层的名字 → 值表；查找按帧数组从内到外遍历，不沿原型链 */
  readonly vars: ExpressionScope
}

/**
 * 箭头函数的求值中间形态。
 *
 * 只在「实参 → 宿主方法表」之间流转：语法分析已保证箭头函数只能出现在实参位，
 * 所以它不会作为结果值泄漏进渲染输出。
 */
interface Lambda {
  /** 判别字段；`isLambda` 按它识别中间形态，宿主永远拿不到这个值 */
  readonly kind: 'lambda'
  /** 形参名；与回调实参按位置对齐 */
  readonly params: readonly string[]
  /** 箭头函数体 AST，回调每次调用时在新帧里求值 */
  readonly body: ExpressionNode
  /** 创建 lambda 时捕获的作用域帧链，实现闭包语义 */
  readonly frames: readonly Frame[]
}

/** 一次顶层求值的预算与错误上下文 */
interface Runtime {
  /** 表达式原文，仅用于错误文案定位 */
  readonly source: string
  /** 剩余步数预算；每访问一个语法树节点递减 1 */
  steps: number
  /** 当前函数调用深度，与 `callDepthLimit` 比较 */
  depth: number
  /** 本次顶层求值的起点时钟读数 */
  readonly startedAt: number
  /** 距上次取样经过了多少次节点访问 */
  sinceTimeCheck: number
}

/**
 * 时间检查的取样密度（以语法树节点访问次数计）。
 *
 * `now()` 每访问一个节点就调一次会把求值成本抬高一个量级，而超时保护只需要
 * 几十毫秒级的精度，所以按次数取样而不是逐个检查。
 */
const TIME_CHECK_INTERVAL = 256

/**
 * 求值器的预算与外部能力配置。
 *
 * 全部字段必填（除可选回调外）且不做默认：求值器由 `createExpressionEngine`
 * 统一装配默认值，这里再给一份默认只会造成两处口径漂移。
 */
export interface EvaluatorOptions {
  /** 单次顶层求值允许访问的语法树节点次数上限 */
  stepBudget: number
  /**
   * 单次顶层求值的时间预算（毫秒）；传 `Infinity` 关闭。
   *
   * 它补的是步数预算兜不住的那一类：一次原生方法调用只算一个语法树节点，
   * 所以 `bigList.join('')`、`stringify(hugeObject)` 在步数上几乎免费，
   * 实际却能占几十毫秒。
   *
   * 边界要说清楚：**已经在执行中的原生调用无法被中断**，时间预算只能在其返回后
   * 中止后续求值。真正的强隔离需要 Worker（设计文档 §19.4），不在同 realm 内解决。
   */
  timeBudgetMs: number
  /** 单调时钟；注入是为了让超时用例可被确定性测试，默认 `performance.now` */
  now(): number
  /** 函数嵌套调用深度上限 */
  callDepthLimit: number
  /** 名字 → 内置函数或自定义函数 */
  resolveFunction(name: string): ResolvedFunction | undefined
  /**
   * 读到「作用域里根本没有这个名字」时的通知。
   *
   * 结果仍然是 `undefined`（不抛错，理由见 `lookup` 里的注释），但必须留痕：
   * 变量名打错是低代码里最常见的一类「组件不显示」，静默返回 undefined
   * 会让设计器没有任何可解释的线索。
   */
  onUnboundIdentifier?(name: string, source: string): void
}

/**
 * 白名单求值器实例。
 *
 * 只有一个入口 `run`，没有缓存也没有状态：预算与错误上下文都在每次顶层
 * 求值时重建，同一实例可安全并发用于不同表达式与作用域。
 */
export interface Evaluator {
  /**
   * 求值一棵语法树。
   *
   * @param ast 语法树根节点
   * @param scope 顶层作用域
   * @param source 表达式原文，只用于错误文案定位到具体表达式
   */
  run(ast: ExpressionNode, scope: ExpressionScope, source: string): unknown
}

type RelationalOp = '<' | '<=' | '>' | '>='

function isLambda(value: unknown): value is Lambda {
  return typeof value === 'object' && value !== null && (value as Lambda).kind === 'lambda'
}

/** 原始值判定：对象、数组、函数与 Lambda 都不允许直接参与算术与拼接 */
function isPrimitiveValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value !== 'object' && typeof value !== 'function')
  )
}

/** 非负整数下标；`list[-1]` 不属于下标语法，要用 `list.at(-1)` 表达 */
function toArrayIndex(key: string): number | undefined {
  const index = Number(key)
  if (!Number.isInteger(index) || index < 0) return undefined
  return String(index) === key ? index : undefined
}

/**
 * 只读自有数据属性。
 *
 * 「永不走原型链」这条承诺的落地点就在这里：数组分支与对象分支共用同一个读取口，
 * 少一处 `Object.hasOwn` 就是一个可利用的原型入口。
 */
function ownValue(target: object, key: string): unknown {
  return Object.hasOwn(target, key) ? (target as ExpressionScope)[key] : undefined
}

/**
 * 创建白名单求值器。
 *
 * 工厂而不是类：求值逻辑是纯递归下降（`evaluateNode` 按 AST 类别分派），
 * 没有需要封装的可变实例状态；帧链与预算以参数显式传递，方便单测直接构造。
 *
 * 安全约束的实现点集中在本函数内部：属性读取走 `ownValue`（永不沿原型链）、
 * 方法调用走 `host.ts` 白名单表、函数与深度受预算闸门限制。详见文件头注释。
 *
 * @param options 预算、时钟与函数解析回调；全部字段直接生效，不做默认
 * @returns 无状态的求值器实例，可复用于任意数量的顶层求值
 */
export function createEvaluator(options: EvaluatorOptions): Evaluator {
  function lookup(frames: readonly Frame[], name: string): unknown {
    for (const frame of frames) {
      if (Object.hasOwn(frame.vars, name)) return frame.vars[name]
    }
    // 未绑定的名字解析为 undefined 而不是报错：`{{ x ?? 1 }}` 是设计器里的常规写法。
    // 真正的错误在下一跳暴露 —— 对 undefined 取属性会被拒绝，诊断信息依旧完整。
    return undefined
  }

  /** 只在结果已经是 undefined 时才走这一遍，用来区分「绑定了 undefined」与「没有这个名字」 */
  function hasName(frames: readonly Frame[], name: string): boolean {
    return frames.some((frame) => Object.hasOwn(frame.vars, name))
  }

  function bindParams(params: readonly string[], values: readonly unknown[]): ExpressionScope {
    const scope: Record<string, unknown> = {}
    params.forEach((name, index) => {
      scope[name] = values[index]
    })
    return scope
  }

  function fail(runtime: Runtime, kind: ExpressionError['kind'], message: string): never {
    throw new ExpressionError(kind, message, runtime.source)
  }

  function advance(runtime: Runtime): void {
    runtime.steps -= 1
    if (runtime.steps < 0) fail(runtime, 'budget', '表达式求值步数超限')

    runtime.sinceTimeCheck += 1
    if (runtime.sinceTimeCheck >= TIME_CHECK_INTERVAL) {
      runtime.sinceTimeCheck = 0
      checkTime(runtime)
    }
  }

  /** 超过时间预算就中止；调用方决定是抛错还是返回结果，两个预算入口共用这一处判定 */
  function checkTime(runtime: Runtime): void {
    if (options.now() - runtime.startedAt > options.timeBudgetMs) {
      fail(runtime, 'timeout', `表达式求值超过 ${options.timeBudgetMs}ms 时间预算`)
    }
  }

  /** 函数调用深度闸门；宿主函数与声明式函数共用一套，避免两条路径的限额漂移 */
  function withCallDepth<T>(runtime: Runtime, run: () => T): T {
    runtime.depth += 1
    if (runtime.depth > options.callDepthLimit) {
      runtime.depth -= 1
      fail(runtime, 'depth', '函数嵌套调用深度超限')
    }

    try {
      const value = run()
      // 外部代码（宿主函数、原生方法、内置函数）已经在这里跑完了。按调用点检查而不是
      // 只按节点数检查，是因为一次原生调用在语法树上只占一个节点；
      // 只在成功路径检查，是为了不让超时错误覆盖掉 run() 抛出的原始错误。
      checkTime(runtime)
      return value
    } finally {
      runtime.depth -= 1
    }
  }

  /**
   * 读取属性。
   *
   * 接收者为函数时直接拒绝：`fn.call` / `fn.apply` / `fn.bind` 是把字符串变成代码执行的入口，
   * 而表达式里读一个函数对象的属性没有任何正当用途。
   */
  function readProperty(
    runtime: Runtime,
    receiver: unknown,
    key: string,
    optional: boolean,
  ): unknown {
    if (FORBIDDEN_KEYS.has(key)) fail(runtime, 'forbidden-property', `不允许访问属性 ${key}`)

    if (receiver === null || receiver === undefined) {
      if (optional) return undefined
      fail(runtime, 'invalid-operand', `不能对 ${describeType(receiver)} 读取属性 ${key}`)
    }

    if (typeof receiver === 'function') {
      fail(runtime, 'forbidden-property', '不允许读取函数对象的属性')
    }

    if (Array.isArray(receiver)) {
      if (key === 'length') return receiver.length
      const index = toArrayIndex(key)
      if (index !== undefined) return receiver[index]
      return ownValue(receiver, key)
    }

    if (typeof receiver === 'string') {
      if (key === 'length') return receiver.length
      const index = toArrayIndex(key)
      return index === undefined ? undefined : receiver[index]
    }

    if (typeof receiver === 'object') return ownValue(receiver, key)

    return undefined
  }

  /** 关系比较：两侧都是字符串时按码元比较（与 JS 关系运算符一致），否则按数字比较 */
  function relational(
    runtime: Runtime,
    op: RelationalOp,
    left: unknown,
    right: unknown,
  ): boolean {
    if (typeof left === 'string' && typeof right === 'string') {
      return op === '<'
        ? left < right
        : op === '<='
          ? left <= right
          : op === '>'
            ? left > right
            : left >= right
    }

    const a = toNumber(left, runtime.source)
    const b = toNumber(right, runtime.source)
    return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b
  }

  /**
   * 宽松相等。
   *
   * 只覆盖原始值之间的转换比较；对象参与时退化为引用相等，不做 JS 的 ToPrimitive ——
   * 那需要调用 `valueOf` / `toString`，而这两个名字正因原型方法不可达而被排除在外。
   */
  function looseEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true

    const leftNullish = left === null || left === undefined
    const rightNullish = right === null || right === undefined
    if (leftNullish || rightNullish) return leftNullish && rightNullish

    if (!isPrimitiveValue(left) || !isPrimitiveValue(right)) return false
    if (typeof left === 'string' && typeof right === 'string') return left === right

    return Number(left) === Number(right)
  }

  /**
   * `+` 的两种身份：任一侧是字符串则拼接，否则算术相加。
   *
   * 对象与数组直接报错，不接受 JS 的 `[object Object]` 强转 ——
   * 那会把一个结构性 bug 变成一行看起来像数据的字符串，在设计器里无法排查。
   */
  function add(runtime: Runtime, left: unknown, right: unknown): unknown {
    if (!isPrimitiveValue(left) || !isPrimitiveValue(right)) {
      fail(runtime, 'invalid-operand', '对象与数组不能用 + 运算')
    }

    if (typeof left === 'string' || typeof right === 'string') {
      return toDisplayString(left) + toDisplayString(right)
    }
    return toNumber(left, runtime.source) + toNumber(right, runtime.source)
  }

  function applyBinary(
    runtime: Runtime,
    op: ExpressionBinaryOp,
    left: unknown,
    right: unknown,
  ): unknown {
    switch (op) {
      case '+':
        return add(runtime, left, right)
      case '-':
        return toNumber(left, runtime.source) - toNumber(right, runtime.source)
      case '*':
        return toNumber(left, runtime.source) * toNumber(right, runtime.source)
      case '/':
        return toNumber(left, runtime.source) / toNumber(right, runtime.source)
      case '%':
        return toNumber(left, runtime.source) % toNumber(right, runtime.source)
      case '<':
        return relational(runtime, '<', left, right)
      case '<=':
        return relational(runtime, '<=', left, right)
      case '>':
        return relational(runtime, '>', left, right)
      case '>=':
        return relational(runtime, '>=', left, right)
      case '===':
        return left === right
      case '!==':
        return left !== right
      case '==':
        return looseEqual(left, right)
      case '!=':
        return !looseEqual(left, right)
    }
  }

  /** 把语法树里的箭头函数换成宿主方法表能用的 JS 回调 */
  function toCallback(runtime: Runtime, value: unknown): unknown {
    if (typeof value === 'function') return value
    if (!isLambda(value)) fail(runtime, 'not-a-function', '该参数位置需要箭头函数')

    return (...nativeArgs: unknown[]) =>
      evaluateNode(
        value.body,
        [{ vars: bindParams(value.params, nativeArgs) }, ...value.frames],
        runtime,
      )
  }

  /** 直接按名调用：注册表函数（内置 / 声明式）优先于作用域里的函数值 */
  function evalIdentifierCall(
    name: string,
    node: ExpressionCallNode,
    frames: readonly Frame[],
    runtime: Runtime,
    invokeArgs: (thisArg: unknown, fn: CallableFunction) => unknown,
  ): unknown {
    const resolved = options.resolveFunction(name)
    if (resolved) {
      return withCallDepth(runtime, () => {
        const args = node.args.map((arg) => evaluateNode(arg, frames, runtime))
        if (resolved.kind === 'builtin') return resolved.apply(args, runtime.source)
        // 声明式函数只看得见形参，不回链调用处帧：见 schema/functions.ts 的 body 注释
        return evaluateNode(
          resolved.body,
          [{ vars: bindParams(resolved.params, args) }],
          runtime,
        )
      })
    }

    const value = lookup(frames, name)
    if (value === null || value === undefined) {
      if (node.optional) return undefined
      fail(runtime, 'unknown-function', `${name} 既不是已注册函数，也不在作用域里`)
    }
    if (typeof value !== 'function') fail(runtime, 'not-a-function', `${name} 不是函数`)

    return invokeArgs(undefined, value)
  }

  /**
   * 成员 / 下标调用：先查接收者类型对应的白名单方法表，表外退回「自有函数属性」。
   *
   * `?.()` 在接收者为空时整跳返回 undefined；方法名解析失败同样吞成 undefined，
   * 与 JS 可选链调用的语义一致。
   */
  function evalMemberCall(
    callee: Extract<ExpressionNode, { kind: 'member' | 'index' }>,
    node: ExpressionCallNode,
    frames: readonly Frame[],
    runtime: Runtime,
    invokeArgs: (thisArg: unknown, fn: CallableFunction) => unknown,
  ): unknown {
    const receiver = evaluateNode(callee.object, frames, runtime)
    const key =
      callee.kind === 'member'
        ? callee.property
        : toDisplayString(evaluateNode(callee.index, frames, runtime))

    if ((receiver === null || receiver === undefined) && node.optional) return undefined

    const method = resolveMethodTable(receiver)?.get(key)
    if (method) {
      return withCallDepth(runtime, () => {
        const args = node.args.map((arg) => evaluateNode(arg, frames, runtime))
        for (const position of method.callbackArgs ?? []) {
          args[position] = toCallback(runtime, args[position])
        }
        return method.apply(receiver, args)
      })
    }

    // 白名单表里没有这个名字：退回到「自有函数属性」，仍然不碰原型
    const value = readProperty(runtime, receiver, key, node.optional)
    if (typeof value === 'function') return invokeArgs(receiver, value)
    if (value === undefined && node.optional) return undefined

    fail(runtime, 'not-a-function', `${key} 不是 ${describeType(receiver)} 支持的函数`)
  }

  /**
   * 调用解析顺序：注册表（内置 + 声明式）→ 作用域里的函数值 → 失败。
   *
   * 注册表排在作用域之前，所以页面或物料声明的同名函数会取代宿主注入的那一个，
   * 而内置函数连被覆盖的入口都没有（注册时即拒绝），见 schema/functions.ts。
   */
  function evalCall(
    node: ExpressionCallNode,
    frames: readonly Frame[],
    runtime: Runtime,
  ): unknown {
    const callee = node.callee
    const invokeArgs = (thisArg: unknown, fn: CallableFunction): unknown =>
      withCallDepth(runtime, () =>
        Reflect.apply(
          fn,
          thisArg,
          node.args.map((arg) => evaluateNode(arg, frames, runtime)),
        ),
      )

    if (callee.kind === 'identifier') {
      return evalIdentifierCall(callee.name, node, frames, runtime, invokeArgs)
    }

    if (callee.kind === 'member' || callee.kind === 'index') {
      return evalMemberCall(callee, node, frames, runtime, invokeArgs)
    }

    // 覆盖 `(x => x)(1)`：箭头函数不作为一等可调用值，被调用对象必须是真函数
    const value = evaluateNode(callee, frames, runtime)
    if (typeof value !== 'function') fail(runtime, 'not-a-function', '被调用对象不是函数')

    return invokeArgs(undefined, value)
  }

  /** 下标读取：只接受字符串 / 数字下标，其余一律无效操作数 */
  function evalIndexNode(
    node: Extract<ExpressionNode, { kind: 'index' }>,
    frames: readonly Frame[],
    runtime: Runtime,
  ): unknown {
    const receiver = evaluateNode(node.object, frames, runtime)
    const key = evaluateNode(node.index, frames, runtime)
    if (typeof key !== 'string' && typeof key !== 'number') {
      fail(runtime, 'invalid-operand', '下标只能是字符串或数字')
    }
    return readProperty(runtime, receiver, String(key), node.optional)
  }

  /** 短路求值：`&&` / `||` 返回某一侧的原值，`??` 只在 nullish 时跳到右侧 */
  function evalLogicalNode(
    node: Extract<ExpressionNode, { kind: 'logical' }>,
    frames: readonly Frame[],
    runtime: Runtime,
  ): unknown {
    const left = evaluateNode(node.left, frames, runtime)
    if (node.op === '&&')
      return toBoolean(left) ? evaluateNode(node.right, frames, runtime) : left
    if (node.op === '||')
      return toBoolean(left) ? left : evaluateNode(node.right, frames, runtime)
    return left === null || left === undefined
      ? evaluateNode(node.right, frames, runtime)
      : left
  }

  /** 对象字面量：只用自有数据属性逐键组装 */
  function evalObjectNode(
    node: Extract<ExpressionNode, { kind: 'object' }>,
    frames: readonly Frame[],
    runtime: Runtime,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const property of node.properties) {
      // 属性名不校验：写进去的只是自有数据属性，而读取口 ownValue 会拒绝那些危险名字
      defineDataProperty(result, property.key, evaluateNode(property.value, frames, runtime))
    }
    return result
  }

  /** AST 按节点类别分派的递归主体；含完整子规则的类别拆在 evalXxxNode */
  function evaluateNode(
    node: ExpressionNode,
    frames: readonly Frame[],
    runtime: Runtime,
  ): unknown {
    advance(runtime)

    switch (node.kind) {
      case 'literal':
        return node.value

      case 'identifier': {
        const value = lookup(frames, node.name)
        if (value === undefined && !hasName(frames, node.name)) {
          options.onUnboundIdentifier?.(node.name, runtime.source)
        }
        return value
      }

      case 'member':
        return readProperty(
          runtime,
          evaluateNode(node.object, frames, runtime),
          node.property,
          node.optional,
        )

      case 'index':
        return evalIndexNode(node, frames, runtime)

      case 'call':
        return evalCall(node, frames, runtime)

      case 'unary': {
        const value = evaluateNode(node.argument, frames, runtime)
        if (node.op === '!') return !toBoolean(value)
        if (node.op === '-') return -toNumber(value, runtime.source)
        return toNumber(value, runtime.source)
      }

      case 'binary': {
        const left = evaluateNode(node.left, frames, runtime)
        const right = evaluateNode(node.right, frames, runtime)
        return applyBinary(runtime, node.op, left, right)
      }

      case 'logical':
        return evalLogicalNode(node, frames, runtime)

      case 'conditional':
        return toBoolean(evaluateNode(node.test, frames, runtime))
          ? evaluateNode(node.consequent, frames, runtime)
          : evaluateNode(node.alternate, frames, runtime)

      case 'array':
        return node.elements.map((element) => evaluateNode(element, frames, runtime))

      case 'object':
        return evalObjectNode(node, frames, runtime)

      case 'arrow':
        return { kind: 'lambda' as const, params: node.params, body: node.body, frames }
    }
  }

  return {
    run(ast, scope, source) {
      const runtime: Runtime = {
        source,
        steps: options.stepBudget,
        depth: 0,
        startedAt: options.now(),
        sinceTimeCheck: 0,
      }
      return evaluateNode(ast, [{ vars: scope }], runtime)
    },
  }
}
