import type { Disposable } from '@lc/kernel'
import type { PageSchema } from '@lc/schema'

/** 历史记录条目（对外只暴露元信息，快照由实现内部持有） */
export interface HistoryEntry {
  /** 条目 id */
  id: string
  /** 操作名称，如「移动节点」 */
  label: string
  /** 记录时间戳（毫秒） */
  timestamp: number
}

/** 写入一条历史所需的快照 */
export interface HistoryRecordInput {
  /** 操作名称 */
  label: string
  /** 变更前 schema 快照 */
  before: PageSchema
  /** 变更后 schema 快照 */
  after: PageSchema
}

/**
 * 撤销/重做服务。
 *
 * 实现按「全量 schema 快照」记录，骨架阶段优先保证正确性；
 * 大文档可替换为 patch 逆向记录，契约不变。
 */
export interface HistoryService {
  /** 是否可撤销 */
  readonly canUndo: boolean
  /** 是否可重做 */
  readonly canRedo: boolean
  /** 记录一次正式变更；由文档服务在 record=true 时调用 */
  record(input: HistoryRecordInput): void
  /** 撤销上一步；无可撤销时静默返回 */
  undo(): void
  /** 重做；无可重做时静默返回 */
  redo(): void
  /** 历史条目列表（不含初始状态） */
  list(): readonly HistoryEntry[]
  /** 栈变化通知；撤销/重做按钮据此刷新 */
  onDidChange(listener: () => void): Disposable
}
