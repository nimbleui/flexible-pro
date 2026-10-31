import type { FunctionSchema } from '@lc/schema'
import { isExpressionString } from '@lc/schema'

/**
 * 函数编辑草稿。
 *
 * 编辑态统一用纯文本保存形参（逗号或空白分隔），提交时再切成数组：
 * 表单里维护 `string[]` 需要额外的增删行动作，对「最多三五个参数」的函数
 * 来说成本高于收益。
 */
export interface FunctionDraft {
  /** 函数名，表达式中按此名调用 */
  name: string
  /** 展示标题（可选） */
  title: string
  /** 形参文本，如 `a, b` */
  paramsText: string
  /** 函数体表达式 */
  body: string
  /** 说明（可选） */
  description: string
}

export const EMPTY_FUNCTION_DRAFT: Readonly<FunctionDraft> = Object.freeze({
  name: '',
  title: '',
  paramsText: '',
  body: '',
  description: '',
})

/** 取函数体文本，兼容 schema 里两种承载形式；列表与编辑器只展示这一种口径 */
export function functionBodyText(schema: FunctionSchema): string {
  const { body } = schema
  if (typeof body === 'string') return body
  return isExpressionString(body) ? body.raw : ''
}

/** 把 schema 条目转成编辑草稿 */
export function draftFromSchema(schema: FunctionSchema): FunctionDraft {
  return {
    name: schema.name,
    title: schema.title ?? '',
    paramsText: (schema.params ?? []).join(', '),
    body: functionBodyText(schema),
    description: schema.description ?? '',
  }
}

/**
 * 解析形参文本。
 *
 * 同时接受英文逗号、中文逗号与空白分隔，避免用户从文档里复制
 * `a, b` 或 `a b` 时得到两种不同结果。
 */
export function parseParams(text: string): string[] {
  return text
    .split(/[,，\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** 把表单草稿转成可写入 schema 的函数定义；空的可选字段不落盘 */
export function schemaFromDraft(draft: FunctionDraft): FunctionSchema {
  const name = draft.name.trim()
  const title = draft.title.trim()
  const params = parseParams(draft.paramsText)
  const description = draft.description.trim()

  return {
    name,
    ...(title === '' ? {} : { title }),
    ...(params.length === 0 ? {} : { params }),
    body: draft.body.trim(),
    ...(description === '' ? {} : { description }),
  }
}
