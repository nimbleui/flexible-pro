import { computed } from 'vue'
import type { EventDefinition } from '@lc/schema'
import type { EventFlowStore } from './use-event-flow-store'

/**
 * 选中节点可声明的事件清单。
 *
 * 物料服务契约里的 `MaterialContribution` 没有事件字段，但物料实现可能在运行时
 * 额外挂 `events`；这里做一次运行时探测，探测不到就回落到页面 schema 的
 * `components[].events`（唯一强类型来源），仍为空则让用户手填事件名。
 */
export function useNodeEventDefinitions(store: EventFlowStore) {
  const { document, material, version, selectedNode } = store

  function materialEventDefinitions(componentName: string): EventDefinition[] {
    const entry: unknown = material?.get(componentName)
    if (typeof entry !== 'object' || entry === null || !('events' in entry)) return []
    const events: unknown = entry.events
    return Array.isArray(events) ? events.filter(isEventDefinition) : []
  }

  function schemaEventDefinitions(componentName: string): EventDefinition[] {
    const component = document?.model.schema.components.find(
      (item) => item.meta.name === componentName,
    )
    return component?.events ?? []
  }

  const selectedNodeEvents = computed<EventDefinition[]>(() => {
    version.value
    const node = selectedNode.value
    if (!node) return []

    const byName = new Map<string, EventDefinition>()
    for (const events of [
      schemaEventDefinitions(node.componentName),
      materialEventDefinitions(node.componentName),
    ]) {
      for (const definition of events) {
        if (!byName.has(definition.name)) byName.set(definition.name, definition)
      }
    }
    return [...byName.values()]
  })

  return { selectedNodeEvents }
}

function isEventDefinition(value: unknown): value is EventDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    value.name.length > 0
  )
}
