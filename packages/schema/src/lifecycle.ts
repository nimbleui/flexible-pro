/**
 * 生命周期（Lifecycle）架构定义
 * 本文件定义了组件的生命周期钩子及其关联的事件处理配置。
 * 生命周期钩子允许开发者在组件的特定阶段（如挂载完成、卸载前等）
 * 执行自定义逻辑，类似于 Vue 的 created/mounted 或 React 的 useEffect。
 */

import type { EventHandlerDef } from './events'

/**
 * 生命周期事件名称的字面量联合类型
 * - 'onMount': 组件挂载完成时触发
 * - 'onUnmount': 组件卸载时触发
 * - 'onUpdate': 组件更新时触发
 * - 'onDataChange': 组件绑定的数据发生变化时触发
 */
export type LifecycleEvent = 'onMount' | 'onUnmount' | 'onUpdate' | 'onDataChange'

/**
 * 生命周期架构定义接口
 * 描述一个生命周期钩子的完整配置，包括监听的事件类型、
 * 要执行的事件处理器列表，以及可选的描述信息。
 * 多个处理器将按顺序依次执行。
 */
export interface LifecycleSchema {
  /** 生命周期事件名称 */
  event: LifecycleEvent
  /** 该生命周期事件触发时要执行的事件处理器列表，按顺序依次执行 */
  handlers: EventHandlerDef[]
  /** 该生命周期钩子的用途描述（可选） */
  description?: string
}
