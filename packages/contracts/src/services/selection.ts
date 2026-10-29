import type { Disposable } from '@lc/kernel'

/**
 * 选中集服务。
 *
 * 只保存选中 id、主选中，不负责点击/框选交互；
 * 交互由 `canvas-selection` 插件完成，视觉由覆盖层读取本服务绘制。
 */
export interface SelectionService {
  /** 当前选中的节点 id；顺序即多选顺序 */
  readonly ids: readonly string[]
  /** 主选中节点；最后加入选中集的节点，属性面板以它为准 */
  readonly primary: string | undefined
  /** 覆盖式设置选中集 */
  set(ids: readonly string[]): void
  /** 追加选中 */
  add(ids: readonly string[]): void
  /** 移除选中 */
  remove(ids: readonly string[]): void
  /** 切换单个节点选中态 */
  toggle(id: string): void
  /** 清空选中 */
  clear(): void
  /** 选中集变化通知 */
  onDidChange(listener: () => void): Disposable
}
