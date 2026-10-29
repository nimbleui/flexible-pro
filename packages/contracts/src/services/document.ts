import type { Disposable } from '@lc/kernel'
import type { DocumentModel, PageSchema, SchemaPatch, ValidationIssue } from '@lc/schema'

/** 文档变更选项 */
export interface DocumentApplyOptions {
  /**
   * 是否写入历史并标脏。
   * - `false`：手势预览，只改 schema 用于渲染
   * - `true`：正式提交，生成一条历史记录
   *
   * @default true
   */
  record?: boolean
  /** 历史记录名称，如「移动节点」；仅 record=true 时生效 */
  label?: string
}

/**
 * 文档服务。
 *
 * 文档是 schema 的唯一写入入口：所有变更必须走 `apply(patches)`，
 * 禁止插件直接修改 `model.schema`（事务与历史都依赖这一点）。
 */
export interface DocumentService {
  /** 当前文档只读快照；不可直接修改内部对象 */
  readonly model: Readonly<DocumentModel>
  /** 以 patch 更新文档 */
  apply(patches: readonly SchemaPatch[], options?: DocumentApplyOptions): void
  /**
   * 恢复到指定 schema。
   *
   * 供手势事务取消使用：不写历史、不改变脏状态。
   */
  restore(schema: PageSchema): void
  /** 校验当前文档结构 */
  validate(): ValidationIssue[]
  /** 文档变化通知；手势预览与正式提交都会触发 */
  onDidChange(listener: (model: Readonly<DocumentModel>) => void): Disposable
}

export type { DocumentModel, PageSchema, SchemaPatch, ValidationIssue }
