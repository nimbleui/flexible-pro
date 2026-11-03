/**
 * JSON 文本与值之间的转换。
 *
 * 设计器里凡是「用户直接编辑一段 JSON」的输入框（动作 config 的 json 字段、流程节点的
 * 输入输出映射）都需要同一套规则：空白算清空而不是写 null，半截 JSON 只回错误不落文档。
 * 规则集中在 shared 是因为这两处面板分属不同包，各写一遍会让「空白算不算填了」出现两种答案。
 */

/**
 * JSON 草稿的解析结果，判别联合：只有 `ok: true` 才带可提交的 `value`。
 *
 * 空白文本也算成功（`value: undefined`），语义是「清空字段」而非写入 `null`。
 */
export type JsonDraftResult =
  | {
      /** 判别位：解析成功，可提交 */
      ok: true
      /** 解析出的 JSON 值；空白文本时为 undefined，表示清空该字段 */
      value: unknown
    }
  /** 判别位：JSON 非法，错误文案已随结果返回，不产出可提交的值 */
  | { ok: false; error: string }

/**
 * 把值格式化成缩进两空格的 JSON 文本，供只读展示与输入框初值。
 *
 * `undefined` 映射为空串而不是 `"undefined"`：输入框留空表示「没有这个字段」。
 * 循环引用等 `JSON.stringify` 失败的情况退化成 `String(value)`——展示用的字符串
 * 不值得为它抛错把整个面板带崩。
 *
 * @param value 待格式化的值
 * @returns JSON 文本；`undefined` 时为空串
 */
export function formatJsonValue(value: unknown): string {
  if (value === undefined) return ''
  return JSON.stringify(value, null, 2) ?? String(value)
}

/**
 * 解析 JSON 字段的草稿文本。
 *
 * 半截 JSON 只把错误交回调用方展示，不碰文档——写进去会让该字段永久无法使用，
 * 还会留下一条需要撤销的历史。
 *
 * @param text 输入框当前文本
 * @returns 解析结果；成功时带可提交值，失败时带错误文案
 */
export function parseJsonDraft(text: string): JsonDraftResult {
  if (text.trim() === '') return { ok: true, value: undefined }

  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `JSON 解析失败：${error.message}` : 'JSON 解析失败',
    }
  }
}
