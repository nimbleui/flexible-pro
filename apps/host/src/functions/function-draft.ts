import type { FunctionSchema, ValueTypeSchema } from '@lc/schema'
import { isExpressionString } from '@lc/schema'
import type { TypeNodeDraft } from '../components/common/type-node'
import {
  createTypeNode,
  typeNodeFromValueType,
  valueTypeFromTypeNode,
} from '../components/common/type-node'

/**
 * 函数编辑草稿。
 *
 * 形参是结构化类型节点：名称、类型、说明；对象/数组字段在节点内递归维护。
 */
export interface FunctionDraft {
  /** 函数名，表达式中按此名调用 */
  name: string
  /** 展示标题（可选） */
  title: string
  /** 形参列表 */
  params: TypeNodeDraft[]
  /** 函数体表达式 */
  body: string
  /** 说明（可选） */
  description: string
}

export const EMPTY_FUNCTION_DRAFT: Readonly<FunctionDraft> = Object.freeze({
  name: '',
  title: '',
  params: [],
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
    params: (schema.params ?? []).map((name) =>
      typeNodeFromValueType(name, schema.paramTypes?.[name] ?? { kind: 'unknown' }),
    ),
    body: functionBodyText(schema),
    description: schema.description ?? '',
  }
}

/** 把表单草稿转成可写入 schema 的函数定义；空的可选字段不落盘 */
export function schemaFromDraft(draft: FunctionDraft): FunctionSchema {
  const name = draft.name.trim()
  const title = draft.title.trim()
  const description = draft.description.trim()
  const params: string[] = []
  const paramTypes: Record<string, ValueTypeSchema> = {}

  for (const param of draft.params) {
    const paramName = param.name.trim()
    if (paramName === '' || params.includes(paramName)) continue

    params.push(paramName)
    paramTypes[paramName] = valueTypeFromTypeNode(param)
  }

  return {
    name,
    title,
    ...(params.length === 0 ? {} : { params }),
    ...(Object.keys(paramTypes).length === 0 ? {} : { paramTypes }),
    body: draft.body.trim(),
    description,
  }
}

/** 新建形参节点 */
export function createParamNode(): TypeNodeDraft {
  return createTypeNode('', 'unknown')
}
