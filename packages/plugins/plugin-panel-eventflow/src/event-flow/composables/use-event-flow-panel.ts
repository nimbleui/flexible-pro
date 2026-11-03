import { computed, ref, watch } from 'vue'
import { TABS } from '../constants/panel-tabs'
import type { PanelTab } from '../constants/panel-tabs'
import { useActionChain } from './use-action-chain'
import { useActionFieldEditor } from './use-action-field-editor'
import { useConditionDraft } from './use-condition-draft'
import { useEventConnections } from './use-event-connections'
import { useEventFlowStore } from './use-event-flow-store'
import { useNodeEventDefinitions } from './use-node-event-definitions'

/** 右栏同一时刻只允许展开一块编辑区，避免 260px 高的停靠区被两块表单同时占满 */
export type SettingsSection = 'trigger' | 'action'

/**
 * 事件流面板的状态编排。
 *
 * 各切片 composable 只负责自己那一块数据，跨切片的选中态与草稿回收集中在这里：
 * 「切换事件要清掉动作选中」「切换动作要收起展开区并丢弃条件草稿」这类规则
 * 分散到切片里会让每个切片都依赖别人，放在编排层才符合真实依赖方向。
 */
export function useEventFlowPanel() {
  const store = useEventFlowStore()

  const activeTab = ref<PanelTab>('eventflow')
  const expandedSection = ref<SettingsSection | undefined>(undefined)
  const selectedActionId = ref<string | undefined>(undefined)
  const isActionPickerOpen = ref(false)

  const connections = useEventConnections(store)
  const nodeEvents = useNodeEventDefinitions(store)
  const chain = useActionChain(store, connections.currentConnection, {
    selectedActionId,
    isActionPickerOpen,
  })
  const { cancelConditionTimer, ...condition } = useConditionDraft(store, chain.selectedAction)
  const fields = useActionFieldEditor(store, chain.selectedAction, selectedActionId)

  const activeTabLabel = computed<string>(
    () => TABS.find((tab) => tab.id === activeTab.value)?.label ?? '',
  )

  // 切换连接时丢弃上一处选中与草稿：动作 id 只在所属连接内有意义，
  // 带过去会让右栏展示另一条事件的动作。
  watch(connections.currentConnectionId, () => {
    selectedActionId.value = undefined
    isActionPickerOpen.value = false
    connections.isCreatingEvent.value = false
    connections.eventNameDraft.value = ''
    connections.creatorError.value = ''
    expandedSection.value = undefined
  })

  // 切换选中动作时收起右栏展开区：表单字段属于上一个动作，留在原地会让用户误编辑
  watch(selectedActionId, () => {
    expandedSection.value = undefined
    // 切换动作时丢弃未提交的草稿计时，避免写到新动作上
    cancelConditionTimer()
  })

  function toggleSection(section: SettingsSection): void {
    expandedSection.value = expandedSection.value === section ? undefined : section
  }

  return {
    ...store,
    ...connections,
    ...nodeEvents,
    ...chain,
    ...condition,
    ...fields,
    activeTab,
    activeTabLabel,
    expandedSection,
    selectedActionId,
    isActionPickerOpen,
    toggleSection,
  }
}
