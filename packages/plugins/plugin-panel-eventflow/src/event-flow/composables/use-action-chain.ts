import { computed, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type {
  ActionDeclaration,
  ActionDefinition,
  EventConnection,
  SchemaPatch,
} from '@lc/schema'
import { actionPath, connectionPath, findActionDefinition } from '@lc/schema'
import { actionParamSummary, actionTitle } from '../constants/action-tone'
import type { EventFlowStore } from './use-event-flow-store'

/** 中栏与右栏共享的选中态；由面板编排层持有，切换事件/动作时统一回收 */
export interface ActionSelection {
  /** 当前选中的动作实例 id；undefined 表示未选中 */
  selectedActionId: Ref<string | undefined>
  /** 动作选择器（picker）是否打开 */
  isActionPickerOpen: Ref<boolean>
}

interface ChainItem {
  /** 动作实例 id，同时也是列表 key 与选中态的锚点 */
  id: string
  /** 连接里引用的动作本体；被外部删除后为 undefined，卡片要显示「动作已丢失」 */
  action: ActionDeclaration | undefined
}

/**
 * 动作链切片：链上的展示数据与增删排序。
 *
 * 动作本体存在 `schema.actions` 里、连接只持有 id 数组，因此「删除动作」必须同时
 * 处理引用计数，不能只从当前连接摘掉 id。
 */
export function useActionChain(
  store: EventFlowStore,
  currentConnection: ComputedRef<EventConnection | undefined>,
  selection: ActionSelection,
) {
  const { document, version, commit, nextId } = store
  const { selectedActionId, isActionPickerOpen } = selection

  const actionTable = computed<Record<string, ActionDeclaration>>(() => {
    version.value
    return document?.model.schema.actions ?? {}
  })

  const chainItems = computed<ChainItem[]>(() => {
    const ids = currentConnection.value?.actionIds ?? []
    return ids.map((id) => ({ id, action: actionTable.value[id] }))
  })

  const selectedAction = computed<ActionDeclaration | undefined>(() => {
    const id = selectedActionId.value
    return id ? actionTable.value[id] : undefined
  })

  // 动作被外部删除引用（撤销、其他面板）后，右栏不应继续编辑一个已不属于当前事件的动作
  watch(
    () => currentConnection.value?.actionIds.join('|') ?? '',
    () => {
      const id = selectedActionId.value
      if (id && !currentConnection.value?.actionIds.includes(id)) {
        selectedActionId.value = undefined
      }
    },
  )

  const selectedDefinition = computed<ActionDefinition | undefined>(() => {
    const action = selectedAction.value
    return action ? findActionDefinition(action.type) : undefined
  })

  /** 右栏第二行复用动作卡片同一套标题与参数摘要，两处口径不会分叉 */
  const selectedActionSummary = computed<string>(() => {
    version.value
    const action = selectedAction.value
    if (action) return `${actionTitle(action)} ${actionParamSummary(action)}`
    return selectedActionId.value ? '动作已丢失' : '未选择动作'
  })

  function selectAction(actionId: string): void {
    selectedActionId.value = actionId
  }

  function moveAction(index: number, delta: number): void {
    const connection = currentConnection.value
    if (!connection) return

    const target = index + delta
    if (target < 0 || target >= connection.actionIds.length) return

    const next = [...connection.actionIds]
    const [moved] = next.splice(index, 1)
    if (moved === undefined) return
    next.splice(target, 0, moved)

    commit(
      [{ op: 'replace', path: connectionPath(connection.id, 'actionIds'), value: next }],
      '调整动作顺序',
    )
  }

  function removeAction(actionId: string): void {
    const connection = currentConnection.value
    if (!document || !connection) return

    const next = connection.actionIds.filter((id) => id !== actionId)
    if (next.length === connection.actionIds.length) return

    const patches: SchemaPatch[] = [
      { op: 'replace', path: connectionPath(connection.id, 'actionIds'), value: next },
    ]

    // 动作可在多条连接间复用；只有确认没有其他事件仍引用它时才删除动作本体，
    // 否则会把别人的动作链一起删断。引用清理与动作删除同批提交，一条历史即可撤销。
    const stillUsed = Object.values(document.model.schema.connections ?? {}).some(
      (item) => item.id !== connection.id && item.actionIds.includes(actionId),
    )
    if (!stillUsed && document.model.schema.actions?.[actionId]) {
      patches.push({ op: 'remove', path: actionPath(actionId) })
    }

    commit(patches, '删除动作')
    if (selectedActionId.value === actionId) selectedActionId.value = undefined
  }

  function addAction(type: string): void {
    const connection = currentConnection.value
    if (!document || !connection) return

    const actions = document.model.schema.actions ?? {}
    const action: ActionDeclaration = {
      id: nextId('action', Object.keys(actions)),
      type,
      config: {},
    }

    // 连接与动作分属两张表，必须同一批提交：否则历史里会出现「连接已引用、动作尚未创建」
    // 的中间态，撤销一步也会留下指向不存在动作的悬空引用。
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

    selectedActionId.value = action.id
    isActionPickerOpen.value = false
  }

  return {
    chainItems,
    selectedAction,
    selectedDefinition,
    selectedActionSummary,
    selectAction,
    moveAction,
    removeAction,
    addAction,
  }
}
