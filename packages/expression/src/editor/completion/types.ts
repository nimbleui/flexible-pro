import type { FunctionDescriptor } from '@lc/schema'
import type { ScopeSymbol } from '../scope'

/**
 * 补全项的类别。
 *
 * 决定列表里的图标与分组展示；`method` / `property` 来自符号树的类型推断，
 * `function` / `variable` / `keyword` 来自根级作用域或语言关键字。
 */
export type CompletionKind = 'function' | 'method' | 'property' | 'variable' | 'keyword'

/**
 * 一条补全候选。
 *
 * 字段集对齐 CodeMirror 的 completion 契约但刻意不依赖编辑器库：
 * `snippet` 只描述模板文本，片段展开行为由宿主编辑器完成。
 */
export interface CompletionItem {
  /** 展示在补全列表里的文本 */
  label: string
  /** 类别徽章，决定列表图标与分组展示 */
  kind: CompletionKind
  /** 列表行右侧的签名 / 来源提示 */
  detail: string
  /** 展开后的详细说明 */
  documentation?: string
  /** 选中后实际插入的文本；缺省插入 label */
  insertText?: string
  /**
   * CodeMirror 片段模板。
   *
   * 存在时编辑器应插入片段（`${name}` 为可跳转占位符），而不是普通文本；
   * 这里只描述模板，不依赖 CodeMirror 类型。
   */
  snippet?: string
}

/**
 * 补全输出。
 *
 * 前缀边界已由词法分析算好，编辑器只需替换 `[from, 光标)` 区间，
 * 不必自己回退切词。
 */
export interface CompletionResult {
  /** 需要被替换的文本起点（相对完整文本）；终点恒为光标位置 */
  from: number
  /** 候选列表；数组顺序即展示顺序 */
  options: CompletionItem[]
}

/**
 * 补全请求的输入上下文。
 *
 * `text` 与 `offset` 共用同一坐标空间；`template` 模式下内部换算到
 * `{{ }}` 内层坐标，返回的 `from` 仍是相对完整文本的位置。
 */
export interface CompletionContext {
  /** 完整表达式文本 */
  text: string
  /** 光标偏移量（0 ~ text.length） */
  offset: number
  /** 当前作用域可见的函数，通常来自 `FunctionRegistry.describe()` */
  functions: readonly FunctionDescriptor[]
  /**
   * 当前作用域可见的符号树。
   *
   * 函数体只放形参（保持纯函数语义），页面表达式放 `buildPageSymbols()` 的结果，
   * 因此 `data.user.` 可以按声明类型收窄字段与方法。
   */
  symbols?: readonly ScopeSymbol[]
  /**
   * 补全模式。
   *
   * - `expression`：整段文本就是表达式（函数体、事件条件）
   * - `template`：文本里只有 `{{ ... }}` 内部才提示（属性值等混合文本）
   *
   * @default 'expression'
   */
  mode?: 'expression' | 'template'
}
