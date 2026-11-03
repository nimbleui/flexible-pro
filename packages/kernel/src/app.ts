import { Context } from './context'
import { EventBus } from './events'
import { InternalBus } from './internal'
import { PluginRuntime } from './runtime'
import type { PluginRecord } from './types'

/** 应用根上下文创建选项。 */
export interface AppOptions {
  /** 根 record 名称，用于诊断与审计 @default 'app' */
  id?: string
  /**
   * 平台预置的服务授权：插件名 → 保留服务名。
   *
   * 生产环境应由 loader 校验签名/认证等级后签发；骨架阶段由 bootstrap 显式声明，
   * 以便在没有控制面的情况下跑通内置服务。
   */
  grants?: Record<string, readonly string[]>
}

/**
 * 根上下文对应的合成记录：它不对应任何插件定义，只为让根 Context 与
 * 普通插件实例走同一套记录结构，devtools 才能统一渲染层级树。
 */
function createRootRecord(id: string): PluginRecord {
  return {
    id,
    name: id,
    state: 'active',
    rawConfig: undefined,
    config: undefined,
    context: null,
    parent: null,
    inject: { required: [], optional: [] },
    provides: [],
    error: undefined,
    attempts: 0,
  }
}

/**
 * 创建应用根上下文与插件运行时。
 *
 * 只做最小启动：内核不安装任何业务服务，核心服务由 `@lc/presets` 中的
 * 预设插件按依赖顺序挂载。
 */
export function createApp(options: AppOptions = {}): Context {
  const id = options.id ?? 'app'
  const rootRecord = createRootRecord(id)

  const context = new Context(
    null,
    rootRecord,
    { services: new Map(), filter: null },
    new AbortController(),
    new EventBus(),
    new InternalBus(),
  )

  context.runtime = new PluginRuntime(context)
  rootRecord.context = context

  for (const [pluginId, names] of Object.entries(options.grants ?? {})) {
    context.runtime.grant(pluginId, names)
  }

  return context
}
