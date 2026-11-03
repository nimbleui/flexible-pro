import type {
  ExpressionNode,
  FunctionDescriptor,
  FunctionRegistration,
  FunctionRegistry,
  FunctionSchema,
  FunctionScopeLevel,
  ValueTypeSchema,
} from '@lc/schema'
import type { BuiltinFunction } from './host'
import { BUILTIN_DOCS, BUILTIN_FUNCTIONS, BUILTIN_NAMES } from './host'
import { inferExpression } from './infer'
import { ExpressionError } from './errors'
import { parseExpressionSource } from './parser'
import { unwrapBraces } from './source'

/**
 * 自定义函数注册表。
 *
 * 结构就是「按名字分栈 + 层级比较」，不是通用扩展点：
 * 只有 `material` / `page` 两个写入层，内置函数由引擎自己持有。
 * 用栈而不是单值，是为了让 dispose 精确回退 —— 物料注册了 `fmt`、
 * 页面又覆盖同名 `fmt`，页面切换后必须回到物料的那一份，
 * 单值实现在这里会静默丢掉物料函数。
 */

/** 注册表在求值期间可解析的函数形态 */
export type ResolvedFunction =
  /** 声明式函数：schema 里的函数声明，编译为 AST 后由求值器解释执行 */
  | {
      /** 判别字段；声明式与内置两条执行路径在此分叉 */
      readonly kind: 'declared'
      /** 形参名列表；与实参按位置对齐，多余实参忽略 */
      readonly params: readonly string[]
      /** 函数体 AST；注册时已编译，求值时不再解析 */
      readonly body: ExpressionNode
    }
  /** 内置函数：由 host.ts 直接持有的 JS 实现，不可被覆盖 */
  | {
      readonly kind: 'builtin'
      /** 实现体；args 为已求值实参，expression 是当前表达式原文（供错误文案） */
      readonly apply: BuiltinFunction
    }

type DiagnosticSink = (error: unknown, detail: Record<string, unknown>) => void

const LEVEL_ORDER: Readonly<Record<FunctionScopeLevel, number>> = {
  global: 1,
  material: 2,
  page: 3,
}

const SCOPE_BY_LEVEL: Readonly<Record<number, FunctionScopeLevel>> = {
  [LEVEL_ORDER.global]: 'global',
  [LEVEL_ORDER.material]: 'material',
  [LEVEL_ORDER.page]: 'page',
}

const RESERVED_NAMES: ReadonlySet<string> = new Set(['true', 'false', 'null', 'undefined'])

const NAME_PATTERN = /^[_$\p{L}][_$\p{L}\p{N}]*$/uy

/**
 * 判断名字能否作为自定义函数名或形参名。
 *
 * 与注册表共用同一套规则，供设计器在写文档前拦截非法输入 ——
 * 两处各写一份正则，迟早会出现「编辑页允许、注册时被拒」的静默失败。
 *
 * @param name 待校验的名字
 * @returns 非空、不是字面量关键字且符合标识符规则时为 true
 */
export function isValidFunctionName(name: string): boolean {
  if (name === '' || RESERVED_NAMES.has(name)) return false
  NAME_PATTERN.lastIndex = 0
  return NAME_PATTERN.test(name)
}

/** 判断名字是否已被内置函数占用；自定义函数不允许覆盖内置语义。 */
export function isBuiltinFunction(name: string): boolean {
  return BUILTIN_NAMES.has(name)
}

/** 名字栈里的一条注册；dispose 按 token 精确移除，不影响同名更高层或更老的条目 */
interface Entry {
  /** 本次注册的身份凭据；Symbol 保证重复注册也能被逐条回退 */
  readonly token: symbol
  /** 层级序号（LEVEL_ORDER 映射后），比较大小决定可见性；数值越大越靠栈顶优先 */
  readonly level: number
  /** 可执行形态；resolve 命中栈顶时直接返回它，与下方展示元字段互不影响 */
  readonly definition: ResolvedFunction
  /** 展示元数据来自注册时的 schema，不进求值路径 */
  readonly title: string | undefined
  /** 参考面板说明文案；仅 describe 消费 */
  readonly description: string | undefined
  /** 类型标注来自 schema，只供编辑器补全与推断 */
  readonly paramTypes: Readonly<Record<string, ValueTypeSchema>> | undefined
  /** 显式声明的返回类型；缺省时由 inferReturn 按函数体推断 */
  readonly returns: ValueTypeSchema | undefined
}

/**
 * 创建函数注册表。
 *
 * @param onDiagnostic 注册失败的上报通道；编译失败的函数被跳过而不是抛错，
 *   因为一个页面里写坏一个函数不应该让整个画布无法渲染
 */
export function createFunctionRegistry(onDiagnostic: DiagnosticSink): {
  /** 面向宿主与引擎的注册面：注册、批量注册、查询与展示 */
  registry: FunctionRegistry
  /** 面向求值器的解析口：内置优先，其次同名栈顶 */
  resolve(name: string): ResolvedFunction | undefined
} {
  const stacks = new Map<string, Entry[]>()

  function push(name: string, entry: Entry): void {
    const stack = stacks.get(name)
    if (stack) stack.push(entry)
    else stacks.set(name, [entry])
  }

  function remove(name: string, token: symbol): void {
    const stack = stacks.get(name)
    if (!stack) return

    const index = stack.findIndex((entry) => entry.token === token)
    if (index < 0) return

    stack.splice(index, 1)
    if (stack.length === 0) stacks.delete(name)
  }

  /** 只在「没有更高层的现存注册」时生效，否则低层重复注册不应该夺走高层的覆盖权 */
  function canOverride(name: string, level: number): boolean {
    const stack = stacks.get(name)
    if (!stack || stack.length === 0) return true
    return (stack[stack.length - 1]?.level ?? 0) <= level
  }

  /** 注册阶段的问题；与「函数体语法错误」区分开，前者是名字层面的拒绝 */
  function report(message: string, detail: Record<string, unknown>): void {
    onDiagnostic(
      new ExpressionError('invalid-registration', message, String(detail.function ?? '')),
      detail,
    )
  }

  function compileDefinition(schema: FunctionSchema): ResolvedFunction | undefined {
    const rejection = nameRejection(schema)
    if (rejection) {
      report(rejection.message, rejection.detail)
      return undefined
    }

    const source = unwrapBraces(bodyText(schema))

    try {
      return {
        kind: 'declared',
        params: schema.params ?? [],
        body: parseExpressionSource(source),
      }
    } catch (error) {
      onDiagnostic(error, { function: schema.name, stage: 'register', expression: source })
      return undefined
    }
  }

  function register(
    fn: FunctionSchema,
    level: FunctionScopeLevel = 'page',
  ): FunctionRegistration {
    const definition = compileDefinition(fn)
    if (!definition) return noopRegistration

    if (!canOverride(fn.name, LEVEL_ORDER[level])) return noopRegistration

    const token = Symbol(fn.name)
    push(fn.name, {
      token,
      level: LEVEL_ORDER[level],
      definition,
      title: fn.title,
      description: fn.description,
      paramTypes: fn.paramTypes,
      returns: fn.returns,
    })

    return { dispose: () => remove(fn.name, token) }
  }

  function registerAll(
    fns: readonly FunctionSchema[],
    level: FunctionScopeLevel = 'page',
  ): FunctionRegistration {
    const registrations = fns.map((fn) => register(fn, level))

    return {
      dispose: () => {
        for (const registration of registrations) registration.dispose()
      },
    }
  }

  function resolve(name: string): ResolvedFunction | undefined {
    const builtin = BUILTIN_FUNCTIONS.get(name)
    if (builtin) return { kind: 'builtin', apply: builtin }

    const stack = stacks.get(name)
    return stack?.[stack.length - 1]?.definition
  }

  /**
   * 列出当前可解析的函数。
   *
   * 内置优先收集，自定义函数按注册顺序追加：同名时只取栈顶的生效条目，
   * 与 `resolve` 的查找顺序保持一致。补全与参考面板都消费这份结果，
   * 因此不存在「补全里有、运行时没有」的第二份清单。
   */
  function describe(): readonly FunctionDescriptor[] {
    const returnCache = new Map<string, ValueTypeSchema>()

    /**
     * 推断自定义函数返回类型。
     *
     * 显式 `returns` 优先；否则按函数体推断，支持函数之间互相调用。
     * `visiting` 兜住递归：环上的函数返回 unknown，不阻塞其余推断。
     */
    function inferReturn(name: string, visiting: ReadonlySet<string>): ValueTypeSchema {
      const cached = returnCache.get(name)
      if (cached) return cached

      const stack = stacks.get(name)
      const top = stack?.[stack.length - 1]
      if (!top || top.definition.kind !== 'declared') return { kind: 'unknown' }

      if (top.returns) {
        returnCache.set(name, top.returns)
        return top.returns
      }

      if (visiting.has(name)) return { kind: 'unknown' }

      const next = new Set(visiting)
      next.add(name)

      const variables: Record<string, ValueTypeSchema> = {}
      for (const param of top.definition.params) {
        variables[param] = top.paramTypes?.[param] ?? { kind: 'unknown' }
      }

      const inferred = inferExpression(top.definition.body, {
        variables,
        resolveFunction: (callee) => inferReturn(callee, next),
      }).type

      returnCache.set(name, inferred)
      return inferred
    }

    const descriptors = builtinDescriptors()
    /** 内置已占用的名字：自定义栈里若仍有同名条目（历史注册），展示时以内置为准 */
    const taken = new Set(descriptors.map((item) => item.name))

    for (const [name, stack] of stacks) {
      if (taken.has(name)) continue
      const top = stack[stack.length - 1]
      if (!top || top.definition.kind !== 'declared') continue

      descriptors.push({
        name,
        params: top.definition.params,
        ...(top.paramTypes ? { paramTypes: top.paramTypes } : {}),
        returns: inferReturn(name, new Set()),
        ...(top.title ? { title: top.title } : {}),
        ...(top.description ? { description: top.description } : {}),
        scope: SCOPE_BY_LEVEL[top.level] ?? 'page',
      })
    }

    return descriptors
  }

  return {
    registry: {
      register,
      registerAll,
      has: (name: string) => BUILTIN_NAMES.has(name) || stacks.has(name),
      describe,
    },
    resolve,
  }
}

/** 函数体允许三种写法，见 schema/functions.ts 的 `FunctionSchema.body` 注释 */
function bodyText(schema: FunctionSchema): string {
  const { body } = schema
  if (typeof body === 'string') return body
  if (body && typeof body === 'object' && body.type === 'expression') return body.raw
  return ''
}

/**
 * 注册名字校验：合法返回 null，否则返回拒绝文案与上报细节。
 *
 * 三类拒绝（缺名 / 非法名 / 覆盖内置）都是名字层面的问题，与「函数体语法错误」
 * 分属不同阶段，集中在这里判定，调用方只负责上报一次。
 *
 * @returns `detail` 的键按诊断约定：`function` 为函数名、`stage` 为阶段。
 */
function nameRejection(
  schema: FunctionSchema,
): { message: string; detail: Record<string, unknown> } | null {
  if (typeof schema.name !== 'string' || schema.name === '') {
    return { message: '自定义函数缺少名字', detail: { stage: 'register' } }
  }

  if (!isValidFunctionName(schema.name)) {
    return {
      message: `自定义函数名字非法: ${schema.name}`,
      detail: { function: schema.name, stage: 'register' },
    }
  }

  if (isBuiltinFunction(schema.name)) {
    return {
      message: `自定义函数不能覆盖内置函数: ${schema.name}`,
      detail: { function: schema.name, stage: 'register' },
    }
  }

  return null
}

/** 内置函数描述符：只收录确实有实现的名字，避免文档先行造成「补全里有、运行时没有」 */
function builtinDescriptors(): FunctionDescriptor[] {
  const descriptors: FunctionDescriptor[] = []
  for (const doc of BUILTIN_DOCS) {
    if (!BUILTIN_FUNCTIONS.has(doc.name)) continue
    descriptors.push({
      name: doc.name,
      params: doc.params,
      returns: doc.returns,
      title: doc.title,
      description: doc.description,
      scope: 'builtin',
    })
  }
  return descriptors
}

const noopRegistration: FunctionRegistration = { dispose: () => {} }
