import type {
  ExpressionNode,
  FunctionRegistration,
  FunctionRegistry,
  FunctionSchema,
  FunctionScopeLevel,
} from '@lc/schema'
import type { BuiltinFunction } from './host'
import { BUILTIN_FUNCTIONS, BUILTIN_NAMES } from './host'
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
  | {
      readonly kind: 'declared'
      readonly params: readonly string[]
      readonly body: ExpressionNode
    }
  | { readonly kind: 'builtin'; readonly apply: BuiltinFunction }

type DiagnosticSink = (error: unknown, detail: Record<string, unknown>) => void

const LEVEL_ORDER: Readonly<Record<FunctionScopeLevel, number>> = {
  material: 1,
  page: 2,
}

const RESERVED_NAMES: ReadonlySet<string> = new Set(['true', 'false', 'null', 'undefined'])

const NAME_PATTERN = /^[_$\p{L}][_$\p{L}\p{N}]*$/uy

interface Entry {
  readonly token: symbol
  readonly level: number
  readonly definition: ResolvedFunction
}

/**
 * 创建函数注册表。
 *
 * @param onDiagnostic 注册失败的上报通道；编译失败的函数被跳过而不是抛错，
 *   因为一个页面里写坏一个函数不应该让整个画布无法渲染
 */
export function createFunctionRegistry(onDiagnostic: DiagnosticSink): {
  registry: FunctionRegistry
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
    if (typeof schema.name !== 'string' || schema.name === '') {
      report('自定义函数缺少名字', { stage: 'register' })
      return undefined
    }

    NAME_PATTERN.lastIndex = 0
    if (RESERVED_NAMES.has(schema.name) || !NAME_PATTERN.test(schema.name)) {
      report(`自定义函数名字非法: ${schema.name}`, { function: schema.name, stage: 'register' })
      return undefined
    }

    if (BUILTIN_NAMES.has(schema.name)) {
      report(`自定义函数不能覆盖内置函数: ${schema.name}`, {
        function: schema.name,
        stage: 'register',
      })
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
    push(fn.name, { token, level: LEVEL_ORDER[level], definition })

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

  return {
    registry: {
      register,
      registerAll,
      has: (name: string) => BUILTIN_NAMES.has(name) || stacks.has(name),
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

const noopRegistration: FunctionRegistration = { dispose: () => {} }
