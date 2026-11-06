/**
 * 表达式编辑器语言服务（`@lc/expression/editor`）。
 *
 * 与运行时引擎共用词法、语法与函数注册表，但不依赖 Vue / DOM：
 * 设计器只负责把补全结果渲染成弹层，把诊断结果映射成编辑器下划线。
 */

export type {
  CompletionContext,
  CompletionItem,
  CompletionKind,
  CompletionResult,
} from './completion'
export { completeExpression } from './completion'

export type { ExpressionIssue } from './diagnostics'
export { diagnoseExpression } from './diagnostics'

export type { ExpressionRef, RefTextMode } from './refs'
export { listExpressionRefs } from './refs'

/**
 * 模板取壳与分段。
 *
 * 出码器需要它把 `共 {{ n }} 项` 翻成 JS 模板字面量；与引擎共用同一份分段规则，
 * 才能保证「设计器里看到的插值」和「出码后跑出来的字符串」是同一个字符串。
 */
export type { TemplateSegment } from '../source'
export { splitTemplate, unwrapBraces } from '../source'

export type { SignatureContext, SignatureHelp } from './signature'
export { signatureHelp } from './signature'

export type { MethodDoc, PropertyDoc } from './catalog'
export { METHOD_DOCS, PROPERTY_DOCS, RECEIVER_LABELS } from './catalog'

export type { ScopeSymbol, ScopeSymbolKind, ScopeSymbolSource } from './scope'
export {
  SCOPE_SOURCE_LABELS,
  SYMBOL_KIND_LABELS,
  scopeSymbolFromType,
  symbolKindOf,
  symbolizeValue,
  symbolsFromSample,
  symbolsToTypeEnv,
  valueTypeFromSample,
  valueTypeFromScopeSymbol,
  valueTypeToSample,
} from './scope'

export type { InferredType, InferOptions } from '../infer'
export { inferExpression } from '../infer'

export type { PageRouteRuntime } from './page-symbols'
export { buildPageSymbols } from './page-symbols'

export { BUILTIN_DOCS, listHostMethods } from '../host'
export type { BuiltinDoc, HostReceiverType } from '../host'
