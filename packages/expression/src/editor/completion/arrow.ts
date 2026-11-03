/**
 * 箭头回调参数的类型绑定。
 *
 * `list.map(x => x.` 里的 `x` 不在任何声明里，只能从 token 回看找到最近的 `=>`，
 * 再回溯它所属的数组方法调用，把元素类型绑到形参上。只处理最近一层回调，
 * 更外层的参数由调用方传入的符号表负责。
 */

import type { ValueTypeSchema } from '@lc/schema'
import type { InferredType } from '../../infer'
import { inferExpression } from '../../infer'
import type { Token } from '../../lexer'
import { parseExpressionSource } from '../../parser'
import type { ScopeSymbol } from '../scope'
import { scopeSymbolFromType } from '../scope'
import { inferenceOptions, receiverStart } from './receiver'
import type { CompletionContext } from './types'

interface ArrowParams {
  /** 形参名列表；空数组表示参数不完整或为空 */
  names: string[]
  /** 参数区域的起点：无括号时为参数名，有括号时为左括号 */
  start: number
}

/** 从 `=>` 前的闭括号向左找配对的开括号；未配对时返回 -1 */
function findArrowParenOpen(tokens: readonly Token[], arrowIndex: number): number {
  let depth = 0

  for (let index = arrowIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    if (token?.type !== 'punct') continue

    if (token.text === ')') depth += 1
    else if (token.text === '(') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return -1
}

function arrowParamsOf(tokens: readonly Token[], arrowIndex: number): ArrowParams {
  const before = tokens[arrowIndex - 1]

  if (before?.type === 'name') {
    return { names: [before.text], start: arrowIndex - 1 }
  }

  if (!before || before.type !== 'punct' || before.text !== ')') {
    return { names: [], start: arrowIndex }
  }

  const openIndex = findArrowParenOpen(tokens, arrowIndex)
  if (openIndex < 0) return { names: [], start: arrowIndex }

  const names: string[] = []
  for (let index = openIndex + 1; index < arrowIndex - 1; index += 1) {
    const token = tokens[index]
    if (token?.type === 'name') names.push(token.text)
  }

  return { names, start: openIndex }
}

/** 找到包住箭头参数的那个调用左括号 */
function findCallOpen(tokens: readonly Token[], paramsStart: number): number | undefined {
  let depth = 0

  for (let index = paramsStart - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    if (token?.type !== 'punct') continue

    if (token.text === ')' || token.text === ']' || token.text === '}') {
      depth += 1
      continue
    }

    if (token.text === '(' || token.text === '[' || token.text === '{') {
      if (depth > 0) {
        depth -= 1
        continue
      }
      return token.text === '(' ? index : undefined
    }
  }

  return undefined
}

/**
 * 光标是否还在箭头函数体里。
 *
 * 箭头参数列表结束后，同一实参位置出现逗号、或包住回调的调用已闭合，
 * 都说明光标落在箭头体之外；例如 `filter(x => x, y.` 里的 x 不应进入补全。
 */
function arrowEnclosesCursor(tokens: readonly Token[], arrowIndex: number): boolean {
  let depth = 0

  for (let index = arrowIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token?.type !== 'punct') continue

    if (token.text === '(' || token.text === '[' || token.text === '{') {
      depth += 1
      continue
    }

    if (token.text === ')' || token.text === ']' || token.text === '}') {
      if (depth === 0) return false
      depth -= 1
      continue
    }

    if (token.text === ',' && depth === 0) return false
  }

  return true
}

const ARRAY_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'map',
  'filter',
  'find',
  'findIndex',
  'some',
  'every',
  'sort',
  'reduce',
])

/** 按数组方法的回调签名绑定参数类型 */
function bindArrowSymbols(
  names: readonly string[],
  method: string | undefined,
  receiver: InferredType | undefined,
): ScopeSymbol[] {
  const item: ValueTypeSchema =
    receiver?.resolved && receiver.type.kind === 'array'
      ? (receiver.type.item ?? { kind: 'unknown' })
      : { kind: 'unknown' }

  const index: ValueTypeSchema = { kind: 'number' }
  const unknown: ValueTypeSchema = { kind: 'unknown' }
  const types: ValueTypeSchema[] = names.map(() => unknown)

  if (method && ARRAY_CALLBACK_METHODS.has(method)) {
    if (method === 'sort') {
      if (types.length > 0) types[0] = item
      if (types.length > 1) types[1] = item
    } else if (method === 'reduce') {
      if (types.length > 1) types[1] = item
      if (types.length > 2) types[2] = index
    } else {
      if (types.length > 0) types[0] = item
      if (types.length > 1) types[1] = index
    }
  }

  return names.map((name, position) =>
    scopeSymbolFromType(name, types[position] ?? unknown, {
      source: 'callback',
      description: method ? `${method} 回调参数` : '回调参数',
    }),
  )
}

/**
 * 识别回调所属的数组方法及其接收者类型。
 *
 * `list.map(` 形态给出 method 与 map 前的表达式推断结果；不是成员调用、
 * 或接收者表达式语法不完整时给出能推多少算多少的部分结果（推断失败不报错）。
 *
 * @returns `method` 为回调所属的数组方法名，接收者推断失败时仍可能给出；
 *   `receiver` 是点号前数组表达式的推断结果，缺省即推断失败，参数按 unknown 绑定。
 */
function arrowCallContext(
  tokens: readonly Token[],
  prefixText: string,
  paramsStart: number,
  context: CompletionContext,
): { method?: string; receiver?: InferredType } {
  const callOpen = findCallOpen(tokens, paramsStart)
  if (callOpen === undefined) return {}

  const callee = memberCalleeOf(tokens, callOpen)
  if (!callee) return {}

  const startIndex = receiverStart(tokens, callOpen - 2)
  const startOffset = tokens[startIndex]?.start ?? 0
  const source = prefixText.slice(startOffset, callee.dot.start)

  try {
    const receiver = inferExpression(parseExpressionSource(source), inferenceOptions(context))
    return { method: callee.callee.text, receiver }
  } catch {
    return { method: callee.callee.text }
  }
}

/**
 * 取「名字 + 点号」形态的被调用者。
 *
 * 分组括号（`(list).map(`）与独立标识符调用（`map(`）都不绑定元素类型：
 * 前者要额外剥括号、后者根本没有接收者，两者的提示收益都不抵解析成本。
 */
function memberCalleeOf(
  tokens: readonly Token[],
  callOpen: number,
): { callee: Token; dot: Token } | undefined {
  const callee = tokens[callOpen - 1]
  const dot = tokens[callOpen - 2]

  if (!callee || callee.type !== 'name') return undefined
  if (!dot || dot.type !== 'punct') return undefined
  if (dot.text !== '.' && dot.text !== '?.') return undefined

  return { callee, dot }
}

/**
 * 找出光标所在的箭头回调，把数组元素类型绑定到回调参数上。
 *
 * 只处理最近一层回调：`list.filter(x => x.` 能提示对象字段；
 * 更外层的回调参数仍由调用方传入的符号表负责。
 */
function collectArrowSymbols(
  prefixText: string,
  tokens: readonly Token[],
  context: CompletionContext,
): ScopeSymbol[] {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    if (token?.type !== 'punct' || token.text !== '=>') continue
    if (!arrowEnclosesCursor(tokens, index)) continue

    const params = arrowParamsOf(tokens, index)
    if (params.names.length === 0) return []

    const { method, receiver } = arrowCallContext(tokens, prefixText, params.start, context)
    return bindArrowSymbols(params.names, method, receiver)
  }

  return []
}

export function withArrowSymbols(
  prefixText: string,
  tokens: readonly Token[],
  context: CompletionContext,
): CompletionContext {
  const locals = collectArrowSymbols(prefixText, tokens, context)
  if (locals.length === 0) return context

  const localNames = new Set(locals.map((symbol) => symbol.name))
  return {
    ...context,
    symbols: [
      ...locals,
      ...(context.symbols ?? []).filter((symbol) => !localNames.has(symbol.name)),
    ],
  }
}
