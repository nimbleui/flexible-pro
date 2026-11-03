import { isExpressionError } from '../errors'
import { parseExpressionSource } from '../parser'
import { unwrapBraces } from '../source'

/** 编辑器里的一条表达式诊断 */
export interface ExpressionIssue {
  /** 可直接展示的中文错误文案，来自 ExpressionError.message 或原始异常 */
  message: string
  /** 出错位置起点（相对原始文本） */
  from: number
  /** 出错位置终点；至少比 from 大 1，便于编辑器画出下划线 */
  to: number
}

function diagnoseInner(inner: string, start: number): ExpressionIssue[] {
  if (inner.trim() === '') return []

  try {
    parseExpressionSource(inner)
    return []
  } catch (error) {
    const offset =
      isExpressionError(error) && typeof error.offset === 'number' ? error.offset : 0
    const from = start + offset

    return [
      {
        message: error instanceof Error ? error.message : String(error),
        from,
        to: from + 1,
      },
    ]
  }
}

/**
 * 诊断混合文本里的每个 `{{ ... }}`。
 *
 * 属性值可能是 `标题 {{ data.title }}` 这种模板，外围文本不是表达式，
 * 不能整段交给 parser；这里只校验模板内部的表达式。
 */
function diagnoseTemplate(text: string): ExpressionIssue[] {
  const issues: ExpressionIssue[] = []
  const pattern = /\{\{([\s\S]*?)\}\}/g
  let consumed = 0

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    issues.push(...diagnoseInner(match[1] ?? '', index + 2))
    consumed = index + match[0].length
  }

  // 未闭合的最后一个模板：用户正在输入时没有 `}}`，仍校验已写内容
  const open = text.indexOf('{{', consumed)
  if (open >= 0) {
    issues.push(...diagnoseInner(text.slice(open + 2), open + 2))
  }

  return issues
}

/**
 * 只做语法诊断，不判断函数是否存在。
 *
 * 函数是否存在取决于当前注册表与作用域，属于运行期信息；编辑器如果拿不到
 * 完全一致的上下文，静态报「未知函数」的误报率会高于收益。
 *
 * @param text 待诊断文本
 * @param mode `expression` 整段是表达式；`template` 只诊断 `{{ ... }}` 内部
 */
export function diagnoseExpression(
  text: string,
  mode: 'expression' | 'template' = 'expression',
): readonly ExpressionIssue[] {
  if (text.trim() === '') return []
  if (mode === 'template') return diagnoseTemplate(text)

  const source = unwrapBraces(text)

  try {
    parseExpressionSource(source)
    return []
  } catch (error) {
    const offset =
      isExpressionError(error) && typeof error.offset === 'number' ? error.offset : 0
    // 去掉 `{{ }}` 后解析偏移量相对内层文本，映射回编辑器里的原始位置
    const sourceStart = Math.max(text.indexOf(source), 0)
    const from = Math.min(sourceStart + offset, Math.max(text.length - 1, 0))

    return [
      {
        message: error instanceof Error ? error.message : String(error),
        from,
        to: Math.min(from + 1, text.length),
      },
    ]
  }
}
