import type { Disposable } from '@lc/kernel'

/**
 * 宿主写入汇聚点 → 版本桥接的单向信号。
 *
 * 独立成零运行时依赖模块是为了打断循环：`page-store` / `release-store` 被
 * `project-assets.ts` 读取，而版本桥接又要通过 `project-assets` 取全量资产。
 * 让两个 store 只认识这个「函数 + Set」模块，桥接侧才能自由 import 五类 store。
 *
 * 信号是**旁路**：版本库故障不得影响保存或发布本身，因此广播同步执行、且不向
 * 调用方抛错；订阅者自己把耗时工作排进异步队列。
 */

export type VersionActivity =
  | { kind: 'save'; projectId: string; docId: string }
  | { kind: 'publish'; projectId: string; revision: number }

const listeners = new Set<(activity: VersionActivity) => void>()

/** 订阅保存 / 发布活动；返回注销句柄，供 HMR 与测试清理。 */
export function onVersionActivity(listener: (activity: VersionActivity) => void): Disposable {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}

/** 广播一次活动；没有订阅者时是零成本的空转。 */
export function emitVersionActivity(activity: VersionActivity): void {
  for (const listener of [...listeners]) {
    try {
      listener(activity)
    } catch (error) {
      console.error('[host] 版本信号订阅者异常', error)
    }
  }
}
