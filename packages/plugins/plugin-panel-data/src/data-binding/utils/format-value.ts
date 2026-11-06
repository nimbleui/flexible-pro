/** 值的单行摘要；面板只做展示，不做可逆序列化 */
const VALUE_LIMIT = 56

/**
 * 把任意 schema 值压成一行短文本。
 *
 * 超长必须截断：数据源结果可能是一整页列表，直接 stringify 会把左列撑成
 * 无法滚动的长条。省略号表示「还有内容」，完整值交给绑定详情列去看。
 */
export function formatValue(value: unknown, limit = VALUE_LIMIT): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'

  const text = typeof value === 'string' ? JSON.stringify(value) : stringifyCompact(value)

  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** 对象与数组走 JSON；循环引用等 stringify 失败的情况退化成类型名 */
function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return Array.isArray(value) ? `Array(${value.length})` : typeof value
  }
}
