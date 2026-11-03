import { EventBus } from './events'
import type { Disposable, PluginRecord } from './types'

/** 内核错误来源阶段。 */
export interface InternalErrorPayload {
  /** 原始抛出品，未经包装：可能是 Error，也可能是插件 throw 的任意值 */
  cause: unknown
  /** 出错实例的实例 id（非逻辑名）：同一插件多实例时要能区分是哪一个 */
  pluginId: string
  /** 插件逻辑名：devtools 按名字聚合展示，与实例 id 各司其职 */
  pluginName: string
  /**
   * 失败发生的阶段，决定错误归入「配置校验」还是「插件主体」。
   *
   * 当前内核只在 config 与 apply 两个阶段发出本载荷；`dispose` 为回收阶段
   * 预留，消费方不能假设它一定不出现。
   */
  phase: 'config' | 'apply' | 'dispose'
}

/**
 * 内核私有事件表。
 *
 * 这些事件驱动生命周期调度，插件拿不到总线引用，因此不能伪造
 * 服务出生/消失或插件状态变化。
 */
interface InternalEventMap {
  /** 服务出现（value 非 undefined）或消失（value 为 undefined） */
  service: (name: string, value: unknown, owner: PluginRecord) => void
  /** 插件状态变化 */
  plugin: (record: PluginRecord) => void
  /** 内核错误 */
  error: (payload: InternalErrorPayload) => void
}

type StoredListener = (this: unknown, ...args: unknown[]) => unknown

/**
 * 内核私有事件总线。
 *
 * @internal 不属于公共 API，由 runtime 独占消费。
 */
export class InternalBus {
  private bus = new EventBus()

  on<K extends keyof InternalEventMap>(name: K, listener: InternalEventMap[K]): Disposable {
    return this.bus.add(name, listener)
  }

  emit<K extends keyof InternalEventMap>(
    name: K,
    ...args: Parameters<InternalEventMap[K]>
  ): void {
    this.bus.emit(name, ...args)
  }
}
