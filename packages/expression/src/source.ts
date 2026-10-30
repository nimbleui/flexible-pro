/**
 * 表达式文本的取壳与分段。
 *
 * schema 里的表达式文本有三种来源形态：整值绑定 `{{ a + b }}`、
 * 混排插值 `"共 {{ n }} 项"`、以及 `FunctionSchema.body` 的裸表达式。
 * 剥壳与分段规则必须只有一份实现，否则「同一个字符串在属性上解析成数字、
 * 在提示文案里解析成字符串」这类差别无法从 schema 上推断。
 */

/** 整段只是一个 `{{ ... }}` 表达式 */
const FULL_TEMPLATE_PATTERN = /^\s*\{\{([\s\S]*)\}\}\s*$/u

/** 混排文本中的一处 `{{ ... }}` 插值 */
const TEMPLATE_PATTERN = /\{\{([\s\S]*?)\}\}/gu

/** 模板分段：静态文本或一段待求值的表达式 */
export type TemplateSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'expression'; readonly text: string }

/**
 * 剥掉整段 `{{ ... }}` 包裹，只保留内部表达式并去掉首尾空白。
 *
 * 空白在本语言里没有语法意义，但它是编译缓存的键 —— 不 trim 的话
 * `{{ a + b }}` 与 `a + b` 会各占一条缓存，并且指向两个不同的编译产物。
 *
 * 混排模板不在这里处理：整值绑定必须保留数字/布尔等原始类型，
 * 而混排插值的结果一定是字符串，两者的求值入口本来就不同。
 */
export function unwrapBraces(text: string): string {
  const matched = FULL_TEMPLATE_PATTERN.exec(text)
  return (matched?.[1] ?? text).trim()
}

/**
 * 把模板串切成静态段与表达式段交替出现的数组。
 *
 * 之所以返回数组而不直接做替换：插值结果要按模板文本缓存，
 * 每次渲染都跑正则替换会让高频渲染路径重复付解析成本。
 */
export function splitTemplate(template: string): TemplateSegment[] {
  if (!template.includes('{{')) return [{ kind: 'text', text: template }]

  const segments: TemplateSegment[] = []
  let cursor = 0

  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ kind: 'text', text: template.slice(cursor, start) })
    segments.push({ kind: 'expression', text: match[1] ?? '' })
    cursor = start + match[0].length
  }

  if (cursor < template.length) segments.push({ kind: 'text', text: template.slice(cursor) })

  return segments
}
