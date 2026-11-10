import { computed, onMounted, onUnmounted, ref } from 'vue'
import type {
  DocumentService,
  FlowService,
  MaterialService,
  SelectionService,
} from '@lc/contracts'
import type { ActionDeclaration, EventConnection, NodeSchema, SchemaPatch } from '@lc/schema'
import {
  actionPath,
  connectionPath,
  flowBindingSummary,
  listFlowBindingOptions,
} from '@lc/schema'
import { createUniquePersistentId } from '@lc/shared'
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

/** 面板一行：事件绑定状态、动作链摘要，以及这条事件绑的流程图 */
export interface NodeEventRow extends EventRow {
  /** 已绑定时的动作链摘要；未绑定为空数组 */
  steps: ChainStep[]
  /**
   * 绑定的流程图说明文案；没绑为空串。
   *
   * 草稿与已删除的图都会在这里说清楚——运行时对这两者都不执行，界面上不写就等于骗人。
   */
  flowSummary: string
  /** 这条绑定现在能不能真的执行；草稿与已删除的图都是 false */
  flowEffective: boolean
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
  // 宿主没装图仓库时下拉只剩「不绑定」，面板照常工作——绑定流程图是可缺省的能力，不是本页签的前提
  const flow = ctx.get<FlowService>('flow')

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
    // 图发布或下线不会动页面文档，不订阅就刷不出「你绑的那张图刚发布了」这条最要紧的变化
    if (flow) disposables.push(flow.onDidChange(bump))
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

  /** 当前项目里的全部图（含草稿），供绑定下拉与状态文案共用 */
  const flows = computed(() => {
    version.value
    return flow?.list() ?? []
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

    return buildEventRows(definitions, connections).map((row) => {
      const flowId = row.connection?.flowId

      return {
        ...row,
        steps: row.connection
          ? describeChain(schema.actions ?? {}, row.connection.actionIds)
          : [],
        flowSummary: flowId ? flowBindingSummary(flows.value, flowId) : '',
        // 没绑时不算「不生效」，否则每行都会顶一条警告；只有真绑了才判断它能不能跑
        flowEffective: flowId
          ? (flows.value.find((item) => item.id === flowId)?.status ?? '') === 'published'
          : true,
      }
    })
  })

  /**
   * 某一行事件的绑定候选。
   *
   * 按行算而不是给整页一份：每条事件当前绑的图不同，而「当前值即使已删除也要出现在
   * 候选里」这条规则必须逐条生效，否则悬空引用会被显示成「未选择」。
   */
  function flowOptionsOf(row: NodeEventRow) {
    return listFlowBindingOptions(flows.value, row.connection?.flowId)
  }

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
      id: createUniquePersistentId('conn', Object.keys(connections)),
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
   * 把这条事件绑到一张流程图上；传空串表示解绑。
   *
   * **事件还没绑定时也能直接选图**：连接是「这个事件的执行记录」，而不是「动作链」的别名，
   * 只跑图、链上一空的动作都不违例。要求先点一次「绑定」才能选流程，等于把同一件事拆成
   * 两个顺序敏感的入口，用户只会看到「这里没有绑流程的地方」。
   *
   * 允许绑草稿：先画图、再在页面上接线、最后发布是正常工序，拦下来只会让人以为这里不能选流程。
   * 不生效的事实由行上的状态文案说清，校验也会报 warning。
   *
   * 解绑走 `remove` 而不是写空串：`flowId: ''` 序列化进文档后是一条永远匹配不到图的
   * 悬空引用，还会被校验报成「不存在」。
   */
  function setFlow(row: NodeEventRow, flowId: string): void {
    const current = node.value
    if (!document || !current) return

    const next = flowId === '' ? undefined : flowId
    const connection = row.connection

    if (connection) {
      if (connection.flowId === next) return

      commit(
        next === undefined
          ? [{ op: 'remove', path: connectionPath(connection.id, 'flowId') }]
          : [{ op: 'replace', path: connectionPath(connection.id, 'flowId'), value: next }],
        next === undefined ? '解绑流程图' : '绑定流程图',
      )
      return
    }

    // 未绑定 + 选了「不绑定」：什么都不写，不产出一条两边都空的连接
    if (!next) return

    const connections = document.model.schema.connections ?? {}
    const created: EventConnection = {
      id: createUniquePersistentId('conn', Object.keys(connections)),
      sourceNodeId: current.id,
      eventName: row.eventName,
      actionIds: [],
      flowId: next,
      enabled: true,
    }

    commit([{ op: 'add', path: connectionPath(created.id), value: created }], '绑定流程图')
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
      id: createUniquePersistentId('action', Object.keys(actions)),
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
    flows,
    flowOptionsOf,
    bind,
    unbind,
    setEnabled,
    setFlow,
    addAction,
    removeAction,
  }
}
