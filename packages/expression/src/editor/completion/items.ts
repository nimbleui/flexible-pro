/**
 * 根级候选项：符号、函数、字面量与顶层片段。
 *
 * 与成员补全（`members.ts`）分开，是因为这里的候选只依赖「可见名字」，
 * 不需要解析接收者表达式。
 */

import type { FunctionDescriptor } from '@lc/schema'
import type { ScopeSymbol } from '../scope'
import { SCOPE_SOURCE_LABELS, SYMBOL_KIND_LABELS } from '../scope'
import type { CompletionContext, CompletionItem } from './types'
import { ROOT_SNIPPETS } from './snippets'

const SCOPE_LABELS: Readonly<Record<FunctionDescriptor['scope'], string>> = {
  builtin: '内置',
  global: '全局',
  material: '物料',
  page: '页面',
}

const KEYWORDS = ['true', 'false', 'null', 'undefined'] as const

/** 表达式标识符区分大小写，补全也按前缀精确匹配，避免把 `Filter` 混进 `filter` */
export function matchesPrefix(name: string, prefix: string): boolean {
  return prefix === '' || name.startsWith(prefix)
}

function scopeDetail(descriptor: FunctionDescriptor): string {
  const params = descriptor.params.join(', ')
  return `(${params}) · ${SCOPE_LABELS[descriptor.scope]}`
}

function documentationOf(descriptor: FunctionDescriptor): string | undefined {
  return [descriptor.title, descriptor.description].filter(Boolean).join(' · ') || undefined
}

function functionItems(
  functions: readonly FunctionDescriptor[],
  prefix: string,
): CompletionItem[] {
  return functions
    .filter((descriptor) => matchesPrefix(descriptor.name, prefix))
    .map((descriptor) => ({
      label: descriptor.name,
      kind: 'function',
      detail: scopeDetail(descriptor),
      documentation: documentationOf(descriptor),
      insertText: `${descriptor.name}(`,
    }))
}

export function symbolDetail(symbol: ScopeSymbol): string {
  const source = symbol.source ? SCOPE_SOURCE_LABELS[symbol.source] : '作用域'
  const flags = [symbol.optional ? '可选' : '', symbol.nullable ? '可为空' : ''].filter(Boolean)

  return `${SYMBOL_KIND_LABELS[symbol.kind]} · ${source}${
    flags.length > 0 ? ` · ${flags.join(' / ')}` : ''
  }`
}

function symbolItems(
  symbols: readonly ScopeSymbol[] | undefined,
  prefix: string,
): CompletionItem[] {
  return (symbols ?? [])
    .filter((symbol) => matchesPrefix(symbol.name, prefix))
    .map((symbol) => ({
      label: symbol.name,
      kind: 'variable',
      detail: symbolDetail(symbol),
      documentation: symbol.description,
      insertText: symbol.name,
    }))
}

function keywordItems(prefix: string): CompletionItem[] {
  return KEYWORDS.filter((name) => matchesPrefix(name, prefix)).map((name) => ({
    label: name,
    kind: 'keyword',
    detail: '字面量',
    insertText: name,
  }))
}

/** 顶层：作用域符号优先，其次函数与片段，最后字面量 */
export function rootItems(prefix: string, context: CompletionContext): CompletionItem[] {
  const snippets: CompletionItem[] =
    prefix === ''
      ? []
      : ROOT_SNIPPETS.filter((item) => matchesPrefix(item.name, prefix)).map((item) => ({
          label: item.label,
          kind: 'keyword',
          detail: item.detail,
          documentation: '插入表达式模板，占位符可依次 Tab 跳转。',
          snippet: item.snippet,
        }))

  return [
    ...symbolItems(context.symbols, prefix),
    ...functionItems(context.functions, prefix),
    ...snippets,
    ...keywordItems(prefix),
  ]
}
