import type { Disposable } from '@lc/kernel'

/**
 * 通用注册表模型。
 *
 * 物料、setter、数据源、动作、命令都符合这个模式，避免每个服务
 * 重新发明一套注册/注销/版本通知逻辑。实现按自身主键取值
 * （物料用 name，命令用 id）。
 */
export interface Registry<T> {
  /** 注册条目；返回 disposable，插件卸载时由 ctx.effect 自动注销 */
  register(item: T): Disposable
  /** 按 key 查找 */
  get(key: string): T | undefined
  /** 列出全部；实现负责返回稳定顺序（通常是注册顺序） */
  list(): readonly T[]
  /** 版本号；Vue 适配层用它触发重渲染，不深度代理条目 */
  readonly version: number
  /** 条目变化通知 */
  onDidChange(listener: () => void): Disposable
}
