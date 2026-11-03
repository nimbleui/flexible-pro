/**
 * 点号左侧接收者的解析与类型推断。
 *
 * 补全只能拿到「光标前的不完整文本」，所以接收者边界必须由 token 反向回看算出：
 * 简单名字链直接查符号树，调用链 / 下标 / 括号表达式则截出源码交给推断引擎。
 */

import type { ValueTypeSchema } from '@lc/schema'
import type { InferredType } from '../../infer'
import { inferExpression } from '../../infer'
import type { Token } from '../../lexer'
import { parseExpressionSource } from '../../parser'
import type { ScopeSymbol } from '../scope'
import { symbolsToTypeEnv } from '../scope'
import type { CompletionContext } from './types'

/** 沿 `data.user.name` 这样的点号链查找符号；任一层缺失即返回 undefined */
export function resolveScopeSymbol(
  symbols: readonly ScopeSymbol[] | undefined,
  segments: readonly string[],
): ScopeSymbol | undefined {
  if (!symbols || segments.length === 0) return undefined

  let current = symbols.find((symbol) => symbol.name === segments[0])
  for (const name of segments.slice(1)) {
    current = current?.children?.find((child) => child.name === name)
    if (!current) return undefined
  }

  return current
}

/**
 * 收集点号左侧的接收者路径。
 *
 * @param tokens 光标前的 token 列表（不含 eof）
 * @param endExclusive 点号 token 的下标；从它前面开始向前收集
 */
export function receiverSegments(tokens: readonly Token[], endExclusive: number): string[] {
  const segments: string[] = []
  let index = endExclusive - 1

  while (index >= 0) {
    const token = tokens[index]
    if (!token || token.type !== 'name') break

    segments.unshift(token.text)

    const dot = tokens[index - 1]
    if (!dot || dot.type !== 'punct' || (dot.text !== '.' && dot.text !== '?.')) break
    index -= 2
  }

  return segments
}

/**
 * 判断收集到的 segments 是否覆盖完整接收者。
 *
 * `makeUser().name.` 会只收集到尾部 `name`，但真正接收者是整个调用链；
 * 若前一个 token 是 `)` / `]` / `}` / 点号，说明左边还有表达式，必须走推断。
 */
export function isSimpleReceiverPath(
  tokens: readonly Token[],
  dotIndex: number,
  segments: readonly string[],
): boolean {
  if (segments.length === 0) return false

  const chainStart = dotIndex - (segments.length * 2 - 1)
  if (chainStart <= 0) return true

  const before = tokens[chainStart - 1]
  if (!before || before.type !== 'punct') return true

  return !(
    before.text === ')' ||
    before.text === ']' ||
    before.text === '}' ||
    before.text === '.' ||
    before.text === '?.'
  )
}

/**
 * 向左跨过一个括号配对。
 *
 * @param closeIndex 闭括号 token 的下标。
 * @returns 开括号左侧一位的下标；扫到列表头仍未配对时返回 -1。
 */
function skipBalancedPairBackward(tokens: readonly Token[], closeIndex: number): number {
  const closer = tokens[closeIndex]?.text ?? ''
  const opener = closer === ')' ? '(' : closer === ']' ? '[' : '{'
  let depth = 1
  let index = closeIndex - 1

  while (index >= 0 && depth > 0) {
    const inner = tokens[index]
    if (inner?.type === 'punct') {
      if (inner.text === closer) depth += 1
      else if (inner.text === opener) depth -= 1
    }
    index -= 1
  }

  return index
}

/**
 * 找到接收者表达式的起点（相对 token 下标）。
 *
 * 简单字段路径由 `receiverSegments` 处理；调用链、下标、括号表达式需要
 * 截出完整源码交给 parser，再由类型推断决定 `.` 后可用的字段与方法。
 */
export function receiverStart(tokens: readonly Token[], endExclusive: number): number {
  let index = endExclusive - 1

  while (index >= 0) {
    const token = tokens[index]
    if (!token) break

    if (token.type === 'punct') {
      if (token.text === ')' || token.text === ']' || token.text === '}') {
        index = skipBalancedPairBackward(tokens, index)
        continue
      }

      if (token.text === '(' || token.text === '[' || token.text === '{') {
        index -= 1
        continue
      }

      if (token.text === '.' || token.text === '?.') {
        index -= 1
        continue
      }

      break
    }

    if (token.type === 'name' || token.type === 'number' || token.type === 'string') {
      index -= 1
      continue
    }

    break
  }

  return index + 1
}

export function inferenceOptions(context: CompletionContext): {
  /** 推断用的变量表；由符号树换算，回调参数已并入 */
  variables: Record<string, ValueTypeSchema>
  /** 名字 → 返回类型；只查调用方传入的声明清单，不经运行时注册表 */
  resolveFunction: (name: string) => ValueTypeSchema | undefined
} {
  const functionReturns: Record<string, ValueTypeSchema> = {}
  for (const descriptor of context.functions) {
    functionReturns[descriptor.name] = descriptor.returns ?? { kind: 'unknown' }
  }

  return {
    variables: symbolsToTypeEnv(context.symbols),
    resolveFunction: (name) => functionReturns[name],
  }
}

/** 用 AST 推断复杂接收者（调用链、下标、括号）的类型 */
export function inferReceiver(
  prefixText: string,
  tokens: readonly Token[],
  dotIndex: number,
  context: CompletionContext,
): InferredType | null {
  const start = receiverStart(tokens, dotIndex)
  const end = tokens[dotIndex]?.start ?? prefixText.length
  if (start < 0 || start >= end) return null

  const source = prefixText.slice(start, end)

  let ast
  try {
    ast = parseExpressionSource(source)
  } catch {
    return null
  }

  return inferExpression(ast, inferenceOptions(context))
}
