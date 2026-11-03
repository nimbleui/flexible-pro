import type { Disposable } from '@lc/kernel'
import type { CanvasContextMenuService, CanvasMenuItem } from '@lc/contracts'

/**
 * 菜单项登记项。
 *
 * 只登记定义，不登记「菜单此刻开在哪个节点上」：`visible` / `enabled` 由渲染方
 * 带目标求值，注册表因此不需要随悬停、选中状态变化而重写条目。
 */
interface MenuItemEntry {
  /** 菜单项定义本体；`list()` 原样返回该引用，渲染方负责调用其回调 */
  item: CanvasMenuItem

  /**
   * 注册时的单调递增序号（从 1 开始）。
   *
   * order 相同时用它保证先到先得，使同一批插件的菜单顺序可复现。
   */
  seq: number
}

/**
 * 创建右键菜单注册表。
 *
 * 排序与图层一致：order 升序，相同则按注册顺序先到先得。注册表只存项目，
 * 不存目标——`visible` / `enabled` 由渲染方带着「菜单开在哪个节点上」求值，
 * 注册方因此不需要知道菜单此刻的状态，插件卸载时项目自动消失。
 */
export function createContextMenuService(): CanvasContextMenuService {
  const items = new Map<string, MenuItemEntry>()
  const listeners = new Set<() => void>()

  // 单调递增序号：order 相同时保持先到先得的稳定顺序
  let seq = 0

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  function sorted(): CanvasMenuItem[] {
    return [...items.values()]
      .sort((a, b) => {
        const orderDiff = (a.item.order ?? 0) - (b.item.order ?? 0)
        if (orderDiff !== 0) return orderDiff
        return a.seq - b.seq
      })
      .map((entry) => entry.item)
  }

  return {
    /**
     * @throws 菜单项 id 重复时抛错：两个插件用同一 id 会让先注册的一方无法替换或清理。
     */
    register(item): Disposable {
      if (items.has(item.id)) {
        throw new Error(`[canvas] 菜单项 id 重复: ${item.id}`)
      }
      const entry = { item, seq: ++seq }
      items.set(item.id, entry)
      notify()

      return {
        dispose: () => {
          // 比对 entry 引用：id 被重新登记后，重复执行的 dispose 不能删掉当前项目
          if (items.get(item.id) !== entry) return
          items.delete(item.id)
          notify()
        },
      }
    },

    list() {
      return sorted()
    },

    onDidChange(listener): Disposable {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }
}
