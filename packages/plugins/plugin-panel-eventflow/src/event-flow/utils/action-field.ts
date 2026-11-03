import type { ActionFieldSchema } from '@lc/schema'

/**
 * 控件一次输入的解析结果，用判别联合强制调用方先看 `accepted` 再取 `value`。
 *
 * `accepted: false` 表示这次输入不应写进文档（目标类型与控件不匹配 / 空值 / 半截
 * JSON），此时不存在可读的 `value`，因此不写成可选字段以免被误取。
 */
export type FieldInput =
  | {
      /** 判别位：合法输入，可安全把 `value` 合并进动作 config */
      accepted: true
      /** 解析后的字段值；具体类型随控件形态而定（toggle→boolean、number→有限数值、text/select→string） */
      value: unknown
    }
  /** 判别位：本次输入应丢弃，不带 `value` 字段 */
  | { accepted: false }

/**
 * 按字段控件形态从事件目标取值。
 *
 * 每种控件的合法输入不同：number 挡掉空串与 NaN（否则一个中间态就会把配置写成
 * `NaN` 或 `null` 进历史），select 挡掉占位的空值，json 有自己的提交路径。
 * 目标类型与控件形态不匹配时同样丢弃，避免冒泡进来的其它控件误写字段。
 */
export function readFieldInput(
  field: ActionFieldSchema,
  target: EventTarget | null,
): FieldInput {
  switch (field.kind) {
    case 'toggle':
      if (!(target instanceof HTMLInputElement)) return { accepted: false }
      return { accepted: true, value: target.checked }
    case 'number': {
      if (!(target instanceof HTMLInputElement)) return { accepted: false }
      if (target.value.trim() === '') return { accepted: false }
      const parsed = Number(target.value)
      if (!Number.isFinite(parsed)) return { accepted: false }
      return { accepted: true, value: parsed }
    }
    case 'select':
      if (!(target instanceof HTMLSelectElement) || target.value === '')
        return { accepted: false }
      return { accepted: true, value: target.value }
    case 'text':
      if (!(target instanceof HTMLInputElement)) return { accepted: false }
      return { accepted: true, value: target.value }
    case 'json':
      return { accepted: false }
  }
}

/** 从事件目标取输入框文本；非表单元素返回空串 */
export function inputValue(event: Event): string {
  const target = event.target
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return target.value
  }
  return ''
}
