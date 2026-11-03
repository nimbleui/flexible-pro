import type { ActionFieldSchema } from '@lc/schema'
import { createExpression, isExpressionString } from '@lc/schema'

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

/** 整串形如 `{{ ... }}` 的文本；这与表达式引擎判定「求值而非插值」的口径一致 */
const WHOLE_EXPRESSION = /^\{\{.*\}\}$/s

/**
 * 把文本框输入折叠成要写进 `config` 的值。
 *
 * 规则与引擎 `resolveValue` 完全对齐，不另立一套：
 *  - 整串是 `{{ ... }}` → 存成表达式对象，求值结果保留原始类型；
 *  - 其余 → 存成普通字符串，运行时按模板插值（`当前计数 {{ n }}` 得到文本）。
 *
 * 为什么不能一律存字符串：`state.set` 的 `{{ count + 1 }}` 若按模板处理，结果是
 * 字符串 `"1"`，下一次 `count + 1` 就变成 `"11"`。整串表达式必须是表达式对象，
 * 数值才留得住。
 */
function toConfigValue(text: string): unknown {
  const trimmed = text.trim()
  return WHOLE_EXPRESSION.test(trimmed) ? createExpression(trimmed) : trimmed
}

/**
 * `kind: 'expression'` 字段的输入折叠。
 *
 * 与 `text` 的差别只有一处：这一类字段的值必须是表达式对象（校验会拒绝裸文本，
 * 因为条件位置上的常量恒为真）。所以作者漏写花括号时在这里替他补上，而不是
 * 存下一个必然校验失败的字符串。
 */
function toExpressionValue(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined

  return createExpression(WHOLE_EXPRESSION.test(trimmed) ? trimmed : `{{ ${trimmed} }}`)
}

/**
 * 判断两次字段值是否等价，用于避免留下内容相同的一条可撤销历史。
 *
 * 表达式对象每次 `createExpression` 都是新引用，直接用 `===` 比会永远不等，
 * 于是用户在同一个框里进出一次就多一条历史记录。
 */
export function sameConfigValue(a: unknown, b: unknown): boolean {
  if (isExpressionString(a) && isExpressionString(b)) return a.raw === b.raw

  return a === b
}

/**
 * 按字段控件形态从事件目标取值。
 *
 * 每种控件的合法输入不同：number 挡掉空串与 NaN（否则一个中间态就会把配置写成
 * `NaN` 或 `null` 进历史），select / action 挡掉占位的空值，json 有自己的提交路径。
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
    case 'action':
      if (!(target instanceof HTMLSelectElement) || target.value === '')
        return { accepted: false }
      return { accepted: true, value: target.value }

    case 'text':
      if (!(target instanceof HTMLInputElement)) return { accepted: false }
      return { accepted: true, value: toConfigValue(target.value) }

    case 'expression':
      if (!(target instanceof HTMLInputElement)) return { accepted: false }
      return { accepted: true, value: toExpressionValue(target.value) }

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
