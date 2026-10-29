import { EventBus } from './events'
import type { Disposable, PluginRecord } from './types'

/** 内核错误来源阶段。 */
export interface InternalErrorPayload {
  cause: unknown
  pluginId: string
  pluginName: string
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
