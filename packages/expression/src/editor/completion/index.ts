/**
 * 表达式补全：框架无关的纯语言服务。
 *
 * 输入是「文本 + 光标 + 当前可见函数」，输出可直接映射为 CodeMirror 补全项。
 * 补全只依赖词法分析：用户正在输入的文本天然是不完整表达式（`list.`），
 * 真正跑一遍 parser 只会拿到语法错误，反而失去判断上下文的机会。
 *
 * 目录内部按「上下文识别」与「候选装配」两条线分工：
 * `receiver.ts` / `arrow.ts` 负责从 token 回看还原光标上下文，
 * `items.ts` / `members.ts` 负责把上下文翻译成候选项，本文件只做分派。
 */

import type { Token } from '../../lexer'
import { tokenize } from '../../lexer'
import { withArrowSymbols } from './arrow'
import { rootItems } from './items'
import { memberItems, memberItemsFromInference } from './members'
import { inferReceiver, isSimpleReceiverPath, receiverSegments } from './receiver'
import type { CompletionContext, CompletionResult } from './types'

export type {
  CompletionContext,
  CompletionItem,
  CompletionKind,
  CompletionResult,
} from './types'

/** 这些标点之后一定期待一个操作数，可以继续提示函数与变量 */
const OPERAND_PUNCTUATORS: ReadonlySet<string> = new Set([
  '(',
  '[',
  '{',
  ',',
  '?',
  ':',
  '=>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '===',
  '!==',
  '==',
  '!=',
  '<=',
  '>=',
  '<',
  '>',
  '&&',
  '||',
  '??',
])

/** 词法回看结果；`ok: false` 专指词法失败，与「成功但无 token」区分开 */
type TokenLookback =
  | {
      /** 词法成功 */
      readonly ok: true
      /** 光标前的 token 序列（不含 eof） */
      readonly tokens: readonly Token[]
    }
  /** 词法失败（如未闭合字符串）；调用方不应继续猜上下文 */
  | { readonly ok: false }

/** 取光标前的 token 列表（去掉 eof）；不完整字符串等词法错误不猜上下文 */
function lastTokens(text: string): TokenLookback {
  try {
    return { ok: true, tokens: tokenize(text).slice(0, -1) }
  } catch {
    return { ok: false }
  }
}

interface TemplateSlice {
  /** `{{ }}` 之间的原始文本，未 trim */
  innerText: string
  /** 内层文本在完整文本中的起点，用于坐标双向换算 */
  innerStart: number
}

/**
 * 定位光标所在的 `{{ ... }}`。
 *
 * 同时支持未闭合的模板：用户正在输入 `{{ data.` 时还没有 `}}`，
 * 此时把 `{{` 之后到文本末尾当作表达式区域。
 */
function locateTemplate(text: string, offset: number): TemplateSlice | null {
  const open = text.lastIndexOf('{{', offset)
  if (open < 0) return null

  const close = text.indexOf('}}', open + 2)
  if (close !== -1 && close < offset) return null

  const innerStart = open + 2
  const innerEnd = close === -1 ? text.length : close

  return { innerText: text.slice(innerStart, innerEnd), innerStart }
}

/** 点号之后的成员补全：符号树命中优先，接收者是复杂表达式时退回类型推断 */
function memberCompletion(
  prefixText: string,
  tokens: readonly Token[],
  dotIndex: number,
  prefix: string,
  from: number,
  context: CompletionContext,
): CompletionResult {
  const segments = receiverSegments(tokens, dotIndex)
  if (isSimpleReceiverPath(tokens, dotIndex, segments)) {
    return { from, options: memberItems(prefix, context.symbols, segments) }
  }

  const inferred = inferReceiver(prefixText, tokens, dotIndex, context)
  return { from, options: inferred ? memberItemsFromInference(prefix, inferred) : [] }
}

/** 标识符之后的补全：点号成员上下文走成员链，否则是根级符号 / 函数 / 字面量 */
function completionAfterName(
  prefixText: string,
  tokens: readonly Token[],
  last: Token,
  previous: Token | undefined,
  context: CompletionContext,
): CompletionResult {
  const isMember =
    previous?.type === 'punct' && (previous.text === '.' || previous.text === '?.')
  if (!isMember) return { from: last.start, options: rootItems(last.text, context) }

  return memberCompletion(prefixText, tokens, tokens.length - 2, last.text, last.start, context)
}

/** 模板模式：定位光标所在内层表达式按表达式模式补全，再把 from 映射回完整文本 */
function completeInTemplate(context: CompletionContext, offset: number): CompletionResult {
  const template = locateTemplate(context.text, offset)
  if (!template) return { from: offset, options: [] }

  const inner = completeExpression({
    ...context,
    text: template.innerText,
    offset: Math.max(0, offset - template.innerStart),
    mode: 'expression',
  })

  return { from: inner.from + template.innerStart, options: inner.options }
}

/**
 * 计算光标处的补全项。
 *
 * @param context 文本、光标与当前可见的函数/变量
 * @returns 替换起点与候选项；无法判断上下文（位于字符串内、词法错误）时返回空列表
 */
export function completeExpression(context: CompletionContext): CompletionResult {
  const offset = Math.max(0, Math.min(context.offset, context.text.length))

  if (context.mode === 'template') return completeInTemplate(context, offset)

  const prefixText = context.text.slice(0, offset)
  const lookback = lastTokens(prefixText)
  if (!lookback.ok) return { from: offset, options: [] }

  const { tokens } = lookback
  const last = tokens[tokens.length - 1]
  const previous = tokens[tokens.length - 2]
  const scopedContext = withArrowSymbols(prefixText, tokens, context)

  if (!last) {
    return { from: offset, options: rootItems('', scopedContext) }
  }

  if (last.type === 'punct' && (last.text === '.' || last.text === '?.')) {
    return memberCompletion(prefixText, tokens, tokens.length - 1, '', offset, scopedContext)
  }

  if (last.type === 'name') {
    return completionAfterName(prefixText, tokens, last, previous, scopedContext)
  }

  if (last.type === 'punct') {
    return {
      from: offset,
      options: OPERAND_PUNCTUATORS.has(last.text) ? rootItems('', scopedContext) : [],
    }
  }

  return { from: offset, options: [] }
}
