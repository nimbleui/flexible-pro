/**
 * 展示层纯函数：把内核里的未知值转成可渲染文本。
 *
 * 与 Vue 无关，devtools 的每个面板都靠它们把 `unknown` 收敛成字符串，
 * 因此可以脱离浏览器单独测试。
 */

/** 序列化最大递归深度；超过后以占位符截断，避免整棵 schema 打进 DOM。 */
const MAX_DEPTH = 12

const MINUTE_MS = 60_000
const SECOND_MS = 1_000

/**
 * 把任意错误值展平成一行文本。
 *
 * 非 Error 走 `String()`，因此 `report('文本')` 这类上报也能展示；
 * 带 `cause` 的错误追加其 message，用于定位被包装的原始失败。
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause
    const suffix = cause instanceof Error ? ` ← ${cause.name}: ${cause.message}` : ''
    return `${error.name}: ${error.message}${suffix}`
  }
  if (typeof error === 'string') return error
  if (error === undefined) return 'undefined'
  if (error === null) return 'null'
  return String(error)
}

/**
 * 耗时格式化。
 *
 * 亚毫秒按十分位显示，避免装配快的插件全部显示「0 ms」；超过一分钟带时分。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < SECOND_MS) return `${ms.toFixed(1)} ms`
  if (ms < MINUTE_MS) return `${(ms / SECOND_MS).toFixed(2)} s`

  const minutes = Math.floor(ms / MINUTE_MS)
  const seconds = Math.round((ms - minutes * MINUTE_MS) / SECOND_MS)
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
}

/** 时间戳转 `HH:MM:SS.mmm`，用于事件与诊断日志的时间列。 */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return [
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `.${pad(date.getMilliseconds(), 3)}`,
  ].join('')
}

/** 缩放倍率转百分比。 */
export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`
}

/**
 * 值的类型摘要。
 *
 * 服务表用它认出「这一格是哪一个实现」，不展开内部结构：
 * 展开会把整棵文档塞进表格，而 devtools 需要的是快速定位。
 */
export function summarizeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (value instanceof Error) return `Error(${value.name})`
  if (Array.isArray(value)) return `Array(${value.length})`
  if (value instanceof Map) return `Map(${value.size})`
  if (value instanceof Set) return `Set(${value.size})`
  if (typeof value === 'function') return `fn(${value.name || 'anonymous'})`
  if (typeof value !== 'object') return typeof value

  const name = value.constructor?.name ?? 'Object'
  const keys = Object.keys(value).length
  return name === 'Object' ? `Object(${keys})` : `${name}(${keys})`
}

/**
 * 生成可安全渲染的 JSON 文本。
 *
 * 直接 `JSON.stringify` 会在循环引用上抛错，在服务实例上打印巨大对象，
 * 所以先归一化：循环、超深、函数、Symbol、bigint 都换成占位符。
 *
 * @param value 任意值
 * @param indent 缩进空格数 @default 2
 */
export function toDisplayJson(value: unknown, indent = 2): string {
  if (value === undefined) return 'undefined'

  const text = JSON.stringify(normalize(value, new WeakSet<object>(), 0), undefined, indent)
  return text ?? 'null'
}

function normalize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null) return null
  if (typeof value !== 'object' && typeof value !== 'function') {
    if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
    return value
  }
  if (depth >= MAX_DEPTH) return '[Depth]'
  if (seen.has(value)) return '[Circular]'
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (value instanceof Error) return describeError(value)

  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => normalize(item, seen, depth + 1))
  if (value instanceof Map) {
    return { '#Map': value.size, ...toEntries(value, seen, depth) }
  }
  if (value instanceof Set) {
    return { '#Set': [...value].map((item) => normalize(item, seen, depth + 1)) }
  }

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = normalize(item, seen, depth + 1)
  }
  return result
}

/**
 * Map 的键值展开。
 *
 * JSON 的键只能是字符串：非字符串键换成类型摘要，避免出现 `[object Object]`。
 */
function toEntries(
  map: Map<unknown, unknown>,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of map) {
    const label = typeof key === 'string' ? key : `[${summarizeValue(key)}]`
    result[label] = normalize(value, seen, depth + 1)
  }
  return result
}
