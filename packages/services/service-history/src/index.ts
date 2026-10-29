import type { DocumentService, HistoryEntry, HistoryService } from '@lc/contracts'
import { defineEditorPlugin } from '@lc/contracts'
import type { PageSchema } from '@lc/schema'
import { createId } from '@lc/shared'

/** 一条历史记录及其两端快照 */
interface SnapshotEntry {
  /** 对外可见的元信息（id、label、时间戳），list() 只返回这一部分 */
  meta: HistoryEntry

  /** 操作前的整份 schema；撤销时直接交给 document.restore */
  before: PageSchema

  /** 操作后的整份 schema；重做时使用 */
  after: PageSchema
}

/**
 * 撤销/重做插件（Realm 级）。
 *
 * 以全量 schema 快照记录，骨架阶段优先保证行为正确；
 * 大文档可替换为 patch 逆向记录，contracts 中的接口不变。
 */
export default defineEditorPlugin({
  name: 'service-history',
  inject: ['document'],

  apply(ctx) {
    const document = ctx.require<DocumentService>('document')
    const undoStack: SnapshotEntry[] = []
    const redoStack: SnapshotEntry[] = []
    const listeners = new Set<() => void>()

    function notify(): void {
      for (const listener of [...listeners]) listener()
    }

    const service: HistoryService = {
      get canUndo() {
        return undoStack.length > 0
      },

      get canRedo() {
        return redoStack.length > 0
      },

      /**
       * 记录一次操作。
       *
       * 新操作会清空 redoStack：撤销后再改一笔，原来的重做分支即失效。
       * before / after 存的是引用——schema 只能被拷贝式 patch 整体替换，
       * 旧对象不会被就地改动，因此全量快照不需要深拷贝。
       * 骨架阶段不设栈深上限，长会话的内存占用需要在接入持久化时再治理。
       */
      record(input) {
        undoStack.push({
          meta: { id: createId('history'), label: input.label, timestamp: Date.now() },
          before: input.before,
          after: input.after,
        })
        redoStack.length = 0
        notify()
      },

      /** 回退一步；栈空时静默返回，调用方应先用 canUndo 决定按钮状态 */
      undo() {
        const entry = undoStack.pop()
        if (!entry) return
        document.restore(entry.before)
        redoStack.push(entry)
        notify()
      },

      /** 重做一步：与 undo 对称，同样不判断边界外的状态一致性 */
      redo() {
        const entry = redoStack.pop()
        if (!entry) return
        document.restore(entry.after)
        undoStack.push(entry)
        notify()
      },

      /** 只列出可撤销的历史，顺序为从旧到新（栈底到栈顶）；重做分支不在这里暴露 */
      list() {
        return undoStack.map((entry) => entry.meta)
      },

      onDidChange(listener) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
    }

    ctx.effect(() => ctx.provide('history', service, { apiVersion: '1.0' }))
  },
})
