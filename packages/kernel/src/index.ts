/**
 * 内核包：Context 树、服务注入、依赖驱动生命周期、effect 自动回收、类型化事件。
 *
 * 零第三方运行时依赖，不依赖 Vue、DOM、Node API。
 */

export { createApp } from './app'
export type { AppOptions } from './app'
export { deepMerge, resolveConfig } from './config'
export {
  Context,
  Diagnostics,
  installServiceAccessors,
  RESERVED_SERVICES,
  ServiceObserver,
} from './context'
export type {
  DiagnosticRecord,
  ProvideOptions,
  ServiceEntry,
  ServiceGrant,
  ServiceScope,
} from './context'
export { EffectScope } from './effect'
export { EventBus } from './events'
export { Service } from './service'
export { PluginRuntime } from './runtime'
export { definePlugin, normalizeInject } from './types'
export type {
  ConfigSchema,
  Disposable,
  EventOptions,
  Events,
  ForkOptions,
  Inject,
  LoadOptions,
  PluginDefinition,
  PluginRecord,
  PluginState,
} from './types'
