import type { FunctionSchema, ValueTypeSchema } from '@lc/schema'
import { isExpressionString } from '@lc/schema'
import type { TypeNodeDraft } from '../components/common/type-node'
import {
  cloneTypeNode,
  createTypeNode,
  typeNodeFromValueType,
  valueTypeFromTypeNode,
} from '../components/common/type-node'
import type { FunctionScope, GlobalFunction } from './global-functions'
import { resolveFunctionScope } from './global-functions'

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

/**
 * 函数控制台草稿。
 *
 * 在表单草稿之上多一个作用域分类：管理页左侧切换条目时草稿按 id 缓存，
 * 未保存的修改不随选中项切换而丢失，因此它比 FunctionDraft 多活一会儿。
 */
export interface FunctionConsoleDraft extends FunctionDraft {
  /** 作用域分类；单选组直接写入，保存时随输入一起落库 */
  scope: FunctionScope
}

/**
 * 从已保存条目生成控制台草稿；null 表示新建。
 *
 * 形参深拷贝一份：缓存里的草稿会被递归增删字段，不能与记录或冻结的空草稿共享引用。
 */
export function consoleDraftFrom(fn: GlobalFunction | null): FunctionConsoleDraft {
  const base = fn ? draftFromSchema(fn) : EMPTY_FUNCTION_DRAFT

  return {
    ...base,
    params: base.params.map(cloneTypeNode),
    scope: resolveFunctionScope(fn?.scope),
  }
}
