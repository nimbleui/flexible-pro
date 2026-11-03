/**
 * JSON 字段草稿的解析与展示。
 *
 * 解析保持纯函数：错误文案作为结果返回，由调用方决定放在哪个输入框下方，
 * 这样草稿归属（哪个动作的哪个字段）与解析结果两件事不会互相污染。
 */

/** 草稿归属键：JSON 输入框按「动作 + 字段」区分，切换动作时不会串草稿 */
export function jsonKeyOf(actionId: string, fieldKey: string): string {
  return `${actionId}:${fieldKey}`
}

export function formatJsonValue(value: unknown): string {
  if (value === undefined) return ''
  return JSON.stringify(value, null, 2) ?? String(value)
}

/**
 * JSON 草稿的解析结果，同样是判别联合：只有 `ok: true` 才带可提交的 `value`。
 *
 * 空白文本也算成功（`value: undefined`），语义是「清空字段」而非写入 `null`。
 */
export type JsonDraftResult =
  | {
      /** 判别位：解析成功，可落文档 */
      ok: true
      /** 解析出的 JSON 值；空白文本时为 undefined，表示清空该字段 */
      value: unknown
    }
  /** 判别位：JSON 非法，错误文案已随结果返回，不产出可提交的值 */
  | { ok: false; error: string }

/**
 * 解析 JSON 字段的草稿文本。
 *
 * 空白文本是「清空字段」而不是「写入 null」，所以返回 `value: undefined`；
 * 半截 JSON 只把错误交回调用方展示，不碰文档——写进去会让动作永久无法执行，
 * 还会留下一条需要撤销的历史。
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
