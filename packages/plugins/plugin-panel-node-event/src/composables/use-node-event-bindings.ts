import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { DocumentService, MaterialService, SelectionService } from '@lc/contracts'
import type { ActionDeclaration, EventConnection, NodeSchema, SchemaPatch } from '@lc/schema'
import { actionPath, connectionPath } from '@lc/schema'
import { createId } from '@lc/shared'
import { useAppContext } from '@lc/vue'
import type { ChainStep, EventRow } from '../utils/event-bindings'
import {
  buildEventRows,
  collectEventDefinitions,
  connectionsOfNode,
  describeChain,
  issuesForConnections,
  orphanedActionIds,
} from '../utils/event-bindings'

/** 面板一行：事件绑定状态加上它的动作链摘要 */
export interface NodeEventRow extends EventRow {
  /** 已绑定时的动作链摘要；未绑定为空数组 */
  steps: ChainStep[]
}

/**
 * 选中节点的事件绑定切片。
 *
 * 与底部事件流面板读写同一份 `connections` / `actions`，但视角不同：这里按节点筛、
 * 只做「接上不接不上」这一层，动作配置与分支结构仍归事件流面板。
 * 因此本切片不持有「当前连接」这类选中态——节点换了，行就跟着换，不需要额外同步。
 */
export function useNodeEventBindings() {
  const ctx = useAppContext()
  const document = ctx.get<DocumentService>('document')
  const selection = ctx.get<SelectionService>('selection')
  const material = ctx.get<MaterialService>('material')

  const version = ref(0)
  /** 挂载期注册的订阅；卸载时逐个释放，面板重挂不会叠加监听 */
  const disposables: Array<{
    /** 解绑这一条订阅，重复调用不安全，因此只在 onUnmounted 走一次 */
    dispose(): void
  }> = []

  const bump = (): void => {
    version.value += 1
  }

  onMounted(() => {
    if (selection) disposables.push(selection.onDidChange(bump))
    if (document) disposables.push(document.onDidChange(bump))
    if (material) disposables.push(material.onDidChange(bump))
  })

  onUnmounted(() => {
    for (const disposable of disposables) disposable.dispose()
    disposables.length = 0
  })

  const selectionCount = computed(() => {
    version.value
    return selection?.ids.length ?? 0
  })

  const node = computed<NodeSchema | undefined>(() => {
    version.value
    const id = selection?.primary
    return id ? document?.model.schema.nodes[id] : undefined
  })

  const rows = computed<NodeEventRow[]>(() => {
    version.value
    const current = node.value
    if (!document || !current) return []

    const schema = document.model.schema
    const definitions = collectEventDefinitions(
      schema.components,
      current.componentName,
      material?.get(current.componentName)?.events,
    )
    const connections = connectionsOfNode(schema.connections ?? {}, current.id)

    return buildEventRows(definitions, connections).map((row) => ({
      ...row,
      steps: row.connection
        ? describeChain(schema.actions ?? {}, row.connection.actionIds)
        : [],
    }))
  })

  /** 本节点连接与动作上的校验问题 */
  const issues = computed(() => {
    version.value
    if (!document || !node.value) return []

    const schema = document.model.schema
    const connections = connectionsOfNode(schema.connections ?? {}, node.value.id)
    return issuesForConnections(document.validate(), connections, schema.actions ?? {})
  })

  function commit(patches: readonly SchemaPatch[], label: string): void {
    if (!document || patches.length === 0) return
    document.apply(patches, { record: true, label })
  }

  /**
   * createId 的序号只保证进程内递增，持久化文档里可能已有同名前缀的键；
   * 对现有键去重后再返回，避免新连接或新动作覆盖旧数据。
   */
  function nextId(prefix: string, taken: readonly string[]): string {
    const used = new Set(taken)
    let id = createId(prefix)
    while (used.has(id)) id = createId(prefix)
    return id
  }

  /**
   * 绑定一个事件。
   *
   * 同一节点同一事件只允许一条连接（`validateDocument` 视为错误），已存在时直接返回，
   * 不产出第二条永远跑不起来的连接。
   */
  function bind(eventName: string): void {
    const current = node.value
    if (!document || !current) return

    const name = eventName.trim()
    if (name === '') return

    const connections = document.model.schema.connections ?? {}
    if (connectionsOfNode(connections, current.id).some((item) => item.eventName === name))
      return

    const connection: EventConnection = {
      id: nextId('conn', Object.keys(connections)),
      sourceNodeId: current.id,
      eventName: name,
      actionIds: [],
      enabled: true,
    }

    commit([{ op: 'add', path: connectionPath(connection.id), value: connection }], '绑定事件')
  }

  /** 解绑连接，并带走只有它在引用的动作；同批提交，一次撤销即可还原 */
  function unbind(connection: EventConnection): void {
    if (!document) return

    const schema = document.model.schema
    const patches: SchemaPatch[] = [{ op: 'remove', path: connectionPath(connection.id) }]

    for (const actionId of orphanedActionIds(
      schema.connections ?? {},
      connection,
      schema.actions ?? {},
    )) {
      patches.push({ op: 'remove', path: actionPath(actionId) })
    }

    commit(patches, '解绑事件')
  }

  function setEnabled(connection: EventConnection, enabled: boolean): void {
    if (connection.enabled === enabled) return
    commit(
      [{ op: 'replace', path: connectionPath(connection.id, 'enabled'), value: enabled }],
      enabled ? '启用事件' : '停用事件',
    )
  }

  /**
   * 给连接追加一个动作。
   *
   * 动作本体与引用分属两张表，必须同一批提交：否则历史里会出现「连接已引用、动作
   * 尚未创建」的中间态，撤销一步也会留下指向不存在动作的悬空引用。
   * 新动作的 `config` 为空，必填字段由校验提示，具体配置去事件流面板填。
   */
  function addAction(connection: EventConnection, type: string): void {
    if (!document) return

    const actions = document.model.schema.actions ?? {}
    const action: ActionDeclaration = {
      id: nextId('action', Object.keys(actions)),
      type,
      config: {},
    }

    commit(
      [
        { op: 'add', path: actionPath(action.id), value: action },
        {
          op: 'replace',
          path: connectionPath(connection.id, 'actionIds'),
          value: [...connection.actionIds, action.id],
        },
      ],
      '新增动作',
    )
  }

  /** 从链上摘掉一个动作；动作还被别的事件复用时只摘引用，不删本体 */
  function removeAction(connection: EventConnection, actionId: string): void {
    if (!document) return

    const next = connection.actionIds.filter((id) => id !== actionId)
    if (next.length === connection.actionIds.length) return

    const schema = document.model.schema
    const patches: SchemaPatch[] = [
      { op: 'replace', path: connectionPath(connection.id, 'actionIds'), value: next },
    ]

    const stillUsed = Object.values(schema.connections ?? {}).some(
      (item) => item.id !== connection.id && item.actionIds.includes(actionId),
    )
    if (!stillUsed && schema.actions?.[actionId]) {
      patches.push({ op: 'remove', path: actionPath(actionId) })
    }

    commit(patches, '删除动作')
  }

  return {
    node,
    selectionCount,
    rows,
    issues,
    bind,
    unbind,
    setEnabled,
    addAction,
    removeAction,
  }
}
