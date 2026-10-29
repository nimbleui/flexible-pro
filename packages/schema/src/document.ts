/**
 * 文档（Document）架构定义
 * ---
 * DocumentModel 是「一份可编辑文档」的运行时视图：持有 PageSchema、版本号与脏状态。
 * 它是设计态与运行时共同的事实来源，但不存放选中、视口、历史等 UI 状态。
 */

import type { PageSchema } from './page'

/** 文档元信息 + 当前 schema 快照 */
export interface DocumentModel {
  /** 文档 id，与 Realm 绑定 */
  id: string
  /** 文档标题，用于标签页与大纲 */
  title: string
  /** 当前 schema；每次变更都会产生新引用 */
  schema: PageSchema
  /** 递增版本号；用于浅比较与历史对齐 */
  version: number
  /**
   * 是否有未保存变更。
   * 预览（手势中）不算脏；只有事务提交或命令写入才置为 true。
   */
  dirty: boolean
}

/** 创建文档所需的输入 */
export interface CreateDocumentInput {
  /** 文档 id */
  id: string
  /** 初始 schema */
  schema: PageSchema
  /** 文档标题；缺省取 schema.metadata.title */
  title?: string
}

/**
 * 深拷贝 schema。
 *
 * schema 必须是 JSON 可序列化数据（这是 DSL 的硬性约束），
 * 因此优先 structuredClone，降级到 JSON 往返。
 */
export function cloneSchema(schema: PageSchema): PageSchema {
  if (typeof structuredClone === 'function') return structuredClone(schema)
  return JSON.parse(JSON.stringify(schema)) as PageSchema
}

/**
 * 创建文档模型。
 *
 * 初始 dirty 为 false：刚打开或刚保存的文档不应显示未保存标记。
 */
export function createDocument(input: CreateDocumentInput): DocumentModel {
  const { schema } = input
  return {
    id: input.id,
    title: input.title ?? schema.metadata?.title ?? input.id,
    schema: cloneSchema(schema),
    version: 1,
    dirty: false,
  }
}
