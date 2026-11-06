import { computed, ref, watch } from 'vue'
import type { EventConnection, ValidationIssue } from '@lc/schema'
import { PAGE_EVENT_SOURCE, actionPath, connectionPath, flowBindingSummary } from '@lc/schema'
import { pageEventLabel } from '../constants/event-tone'
import { inputValue } from '../utils/action-field'
import type { EventFlowStore } from './use-event-flow-store'

/**
 * 事件连接切片：列表、当前选中、创建与改名，以及触发条件摘要。
 *
 * 连接是「节点/页面事件 → 动作链」的那根线，本文件只管这根线本身，
 * 动作本体（`use-action-chain.ts`）与动作配置（`use-action-field-editor.ts`）各自独立。
 */
export function useEventConnections(store: EventFlowStore) {
  const { document, version, commit, nextId, nodeLabel, selectedNode } = store

  const currentConnectionId = ref<string | undefined>(undefined)
  const isCreatingEvent = ref(false)
  const eventNameDraft = ref('')
  const creatorError = ref('')

  const connectionList = computed<EventConnection[]>(() => {
    version.value
    return Object.values(document?.model.schema.connections ?? {})
  })

  const connectionIds = computed<string[]>(() => connectionList.value.map((item) => item.id))

  // 连接可能被别处删除或被历史撤销；当前 id 失效时回落到第一条，避免三栏停在空引用上
  watch(
    () => connectionIds.value.join('|'),
    () => {
      if (
        currentConnectionId.value &&
        connectionIds.value.includes(currentConnectionId.value)
      ) {
        return
      }
      currentConnectionId.value = connectionIds.value[0]
    },
    { immediate: true },
  )

  const currentConnection = computed<EventConnection | undefined>(() => {
    version.value
    const id = currentConnectionId.value
    return id ? document?.model.schema.connections?.[id] : undefined
  })

  function connectionLabel(connection: EventConnection): string {
    if (connection.sourceNodeId === PAGE_EVENT_SOURCE) {
      return pageEventLabel(connection.eventName)
    }
    return `${nodeLabel(connection.sourceNodeId)} · ${connection.eventName}`
  }

  function selectConnection(connectionId: string): void {
    currentConnectionId.value = connectionId
  }

  function toggleEventCreator(): void {
    isCreatingEvent.value = !isCreatingEvent.value
    eventNameDraft.value = ''
    creatorError.value = ''
  }

  /** 同一节点同一事件只允许一条连接（validate.ts 视为错误），重复创建时直接跳到已有连接 */
  function createConnection(sourceNodeId: string, eventName: string): void {
    const trimmed = eventName.trim()
    if (!document || trimmed === '') {
      creatorError.value = '请填写事件名'
      return
    }

    const connections = document.model.schema.connections ?? {}
    const duplicated = Object.values(connections).find(
      (item) => item.sourceNodeId === sourceNodeId && item.eventName === trimmed,
    )
    if (duplicated) {
      currentConnectionId.value = duplicated.id
      toggleEventCreator()
      return
    }

    const connection: EventConnection = {
      id: nextId('conn', Object.keys(connections)),
      sourceNodeId,
      eventName: trimmed,
      actionIds: [],
      enabled: true,
    }

    commit([{ op: 'add', path: connectionPath(connection.id), value: connection }], '新建事件')
    currentConnectionId.value = connection.id
    isCreatingEvent.value = false
    eventNameDraft.value = ''
    creatorError.value = ''
  }

  function createNodeEventFromDraft(): void {
    const node = selectedNode.value
    if (!node) return
    createConnection(node.id, eventNameDraft.value)
  }

  function createSelectedNodeEvent(eventName: string): void {
    const node = selectedNode.value
    if (!node) return
    createConnection(node.id, eventName)
  }

  function onConnectionEnabled(connection: EventConnection, event: Event): void {
    const target = event.target
    if (!(target instanceof HTMLInputElement) || connection.enabled === target.checked) return

    commit(
      [
        {
          op: 'replace',
          path: connectionPath(connection.id, 'enabled'),
          value: target.checked,
        },
      ],
      '切换事件启用',
    )
  }

  function toggleCurrentConnectionEnabled(event: Event): void {
    const connection = currentConnection.value
    if (!connection) return
    onConnectionEnabled(connection, event)
  }

  /** 事件名是连接的触发键；空名会让连接永远无法命中，因此直接丢弃空值而不是写入 */
  function commitEventName(event: Event): void {
    const connection = currentConnection.value
    if (!connection) return

    const name = inputValue(event).trim()
    if (name === '' || name === connection.eventName) return

    commit(
      [{ op: 'replace', path: connectionPath(connection.id, 'eventName'), value: name }],
      '修改事件名',
    )
  }

  /**
   * 右栏第一行的值文案。页面级事件直接描述触发时机；节点事件必须同时给出节点名，
   * 否则同名的 click 事件在多条连接之间无法区分。节点已被删除时退回事件名。
   */
  const triggerSummary = computed<string>(() => {
    version.value
    const connection = currentConnection.value
    if (!connection) return ''

    if (connection.sourceNodeId === PAGE_EVENT_SOURCE) {
      if (connection.eventName === 'pageLoad') return '页面加载时触发'
      if (connection.eventName === 'pageUnload') return '页面卸载时触发'
      return `${pageEventLabel(connection.eventName)}时触发`
    }

    const node = document?.model.schema.nodes[connection.sourceNodeId]
    const name = node ? node.name || node.componentName || node.id : ''
    return name === ''
      ? `${connection.eventName} 时触发`
      : `${name} · ${connection.eventName} 时触发`
  })

  /**
   * 这条连接绑定的流程图说明；没绑时为空串。
   *
   * 绑定写在页面自己的 `connection.flowId` 上，右栏「事件」页签是它的编辑入口，本面板只读展示：
   * 动作链与流程图是同一事件上的两条执行体、都会跑（见 `ActionService.trigger`），
   * 不写出来作者看到的就只有「我只配了链，为什么多跑了一段」。
   *
   * 读的是宿主图仓库的响应式状态，发布 / 下线会连带这里重算；`version` 也读一次，
   * 是为了让「换文档」这种仓库不变的情形同样刷新。
   */
  function flowSummaryFor(connection: EventConnection): string {
    version.value
    return flowBindingSummary(store.flow?.list() ?? [], connection.flowId)
  }

  /** 校验诊断：只展示与当前连接及其动作相关的问题 */
  const currentIssues = computed<ValidationIssue[]>(() => {
    version.value
    const connection = currentConnection.value
    if (!document || !connection) return []

    // validate 用原始 id 拼路径，patch 路径则经过 JSON Pointer 转义，两种前缀都要覆盖
    const prefixes = [connectionPath(connection.id), `/connections/${connection.id}`]
    for (const actionId of connection.actionIds) {
      prefixes.push(actionPath(actionId), `/actions/${actionId}`)
    }

    return document
      .validate()
      .filter((issue) =>
        prefixes.some((prefix) => issue.path === prefix || issue.path.startsWith(`${prefix}/`)),
      )
  })

  return {
    currentConnectionId,
    currentConnection,
    connectionList,
    isCreatingEvent,
    eventNameDraft,
    creatorError,
    connectionLabel,
    selectConnection,
    toggleEventCreator,
    createConnection,
    createNodeEventFromDraft,
    createSelectedNodeEvent,
    onConnectionEnabled,
    toggleCurrentConnectionEnabled,
    commitEventName,
    triggerSummary,
    flowSummaryFor,
    currentIssues,
  }
}
