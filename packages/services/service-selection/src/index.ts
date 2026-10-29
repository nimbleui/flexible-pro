import type { SelectionService } from '@lc/contracts'
import { defineEditorPlugin } from '@lc/contracts'

/**
 * 选中集插件（Realm 级）。
 *
 * 只保存 id 与主选中；点击/框选交互由 canvas-selection 插件负责，
 * 属性面板与覆盖层只读本服务。
 */
export default defineEditorPlugin({
  name: 'service-selection',

  apply(ctx) {
    // 整体替换而不是就地修改：覆盖层与面板拿到的 ids 引用变化即为「选区变了」
    let ids: readonly string[] = []
    const listeners = new Set<() => void>()

    /**
     * 选中集的唯一写入口。
     *
     * 先去重再比较：同一 id 传两次不会多出口一条记录，集合与顺序都没变时直接返回，
     * 不通知也不发事件。比较含顺序，所以 ['a','b'] 与 ['b','a'] 视为变化——
     * primary 取末位，顺序本身是有语义的。
     */
    function update(next: readonly string[]): void {
      const deduped = [...new Set(next)]
      const same =
        deduped.length === ids.length && deduped.every((id, index) => id === ids[index])
      if (same) return

      ids = deduped
      for (const listener of [...listeners]) listener()
      ctx.emit('selection:change', ids)
    }

    const service: SelectionService = {
      /** 内部数组引用，调用方不得 push/splice；需要副本请自行展开 */
      get ids() {
        return ids
      },

      /** 最后加入的 id 即主选中；空集合返回 undefined */
      get primary() {
        return ids[ids.length - 1]
      },

      set(next) {
        update(next)
      },

      /** 追加会把这些 id 移到集合末尾，因此也改变 primary */
      add(next) {
        update([...ids, ...next])
      },

      remove(next) {
        const removed = new Set(next)
        update(ids.filter((id) => !removed.has(id)))
      },

      /** Shift 点选用：已选中则取消，未选中则追加成为主选中 */
      toggle(id) {
        update(ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id])
      },

      clear() {
        update([])
      },

      onDidChange(listener) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
    }

    ctx.effect(() => ctx.provide('selection', service, { apiVersion: '1.0' }))
  },
})
