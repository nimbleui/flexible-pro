import { formatJsonValue } from '@lc/shared'

/**
 * 响应体的 JSON 语法高亮（纯逻辑）。
 *
 * 调试台的响应来自任意外部服务，是**不可信数据**：拼高亮 HTML 前必须先转义，
 * 否则一个返回 `<img onerror=…>` 的接口就能在宿主页面里执行脚本。转义后再按 token
 * 包色，输出逐行交给 `v-html`，行号由视图侧另画。
 */

/** HTML 转义：只处理会改变标签结构的三个字符，引号留在 token 里供正则识别 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * token 识别：字符串（含其后冒号则视为键）、布尔、null、数字。
 *
 * 字符串分支排在最前，保证 `"true"` 这类值整体按字符串着色，不会被内部的裸词分支拆开。
 */
const TOKEN_PATTERN =
  /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

function classify(token: string): string {
  if (token.startsWith('"')) return /:\s*$/.test(token) ? 'key' : 'str'
  if (token === 'true' || token === 'false') return 'bool'
  if (token === 'null') return 'null'
  return 'num'
}

/**
 * 任意值 → 带语法高亮的 HTML 行数组。
 *
 * 每行都已转义，可安全 `v-html`；空值（undefined）给空数组，由视图决定占位文案。
 */
export function highlightJsonLines(value: unknown): string[] {
  const json = formatJsonValue(value)
  if (json === '') return []

  return json
    .split('\n')
    .map((line) =>
      escapeHtml(line).replace(
        TOKEN_PATTERN,
        (match) => `<span class="lc-json-${classify(match)}">${match}</span>`,
      ),
    )
}

/** 非 JSON 响应（原始文本）：仅转义、不着色，同样逐行交给视图 */
export function plainTextLines(text: string): string[] {
  if (text === '') return []
  return text.split('\n').map(escapeHtml)
}
