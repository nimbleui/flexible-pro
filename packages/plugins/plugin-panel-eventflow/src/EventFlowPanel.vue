<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import type { DocumentService, MaterialService, SelectionService } from '@lc/contracts'
import type {
  ActionDeclaration,
  ActionDefinition,
  ActionFieldSchema,
  EventConnection,
  EventDefinition,
  NodeSchema,
  SchemaPatch,
  ValidationIssue,
} from '@lc/schema'
import {
  BUILTIN_ACTIONS,
  PAGE_EVENTS,
  PAGE_EVENT_SOURCE,
  actionPath,
  connectionPath,
  createExpression,
  findActionDefinition,
  isExpressionString,
} from '@lc/schema'
import { createId } from '@lc/shared'
import { useAppContext } from '@lc/vue'

defineProps<{
  /** 宿主传入的只读上下文；面板自己从注入的 Context 取服务 */
  context?: Record<string, unknown>
}>()

const ctx = useAppContext()
const document = ctx.get<DocumentService>('document')
const selection = ctx.get<SelectionService>('selection')
const material = ctx.get<MaterialService>('material')

/** 服务只用来触发重读，数据始终从服务实时取 */
const version = ref(0)
const disposables: Array<{ dispose(): void }> = []

function bump(): void {
  version.value += 1
}

onMounted(() => {
  if (document) disposables.push(document.onDidChange(bump))
  if (selection) disposables.push(selection.onDidChange(bump))
  if (material) disposables.push(material.onDidChange(bump))
})

onUnmounted(() => {
  for (const disposable of disposables) disposable.dispose()
  disposables.length = 0
})

// ---------------------------------------------------------------------------
// 页签（只做选中态，后续页签尚未接入）
// ---------------------------------------------------------------------------

type PanelTab = 'eventflow' | 'data' | 'style' | 'code' | 'perf'
type TabGlyph = 'bolt' | 'chain' | 'swatch' | 'code' | 'wave'

interface PanelTabItem {
  id: PanelTab
  label: string
  glyph: TabGlyph
}

const TABS: readonly PanelTabItem[] = [
  { id: 'eventflow', label: '事件流', glyph: 'bolt' },
  { id: 'data', label: '数据绑定', glyph: 'chain' },
  { id: 'style', label: '样式', glyph: 'swatch' },
  { id: 'code', label: '代码', glyph: 'code' },
  { id: 'perf', label: '性能监控', glyph: 'wave' },
]

const activeTab = ref<PanelTab>('eventflow')

const activeTabLabel = computed<string>(
  () => TABS.find((tab) => tab.id === activeTab.value)?.label ?? '',
)

// ---------------------------------------------------------------------------
// 事件连接
// ---------------------------------------------------------------------------

const PAGE_EVENT_LABELS: Record<string, string> = {
  pageLoad: '页面加载',
  pageUnload: '页面卸载',
}

function pageEventLabel(eventName: string): string {
  return PAGE_EVENT_LABELS[eventName] ?? eventName
}

/**
 * 事件颜色只作为「类型编码」使用，不参与主题换肤，因此集中成命名常量表；
 * 模板只查表，不再写 if 链，新增事件种类时只改这里。
 */
type EventTone = 'pageLoad' | 'pageUnload' | 'pointer' | 'data' | 'other'

const EVENT_STYLE: Record<EventTone, { color: string }> = {
  pageLoad: { color: '#22d3a6' },
  pageUnload: { color: '#7f9bc2' },
  pointer: { color: '#2f8cff' },
  data: { color: '#f5a524' },
  other: { color: '#7f9bc2' },
}

/** 事件名到种类的映射：物料可以声明任意事件名，这里只覆盖常见族，未命中的归入中性色 */
const EVENT_TONE_BY_NAME: Record<string, EventTone> = {
  pageLoad: 'pageLoad',
  pageUnload: 'pageUnload',
  click: 'pointer',
  dblclick: 'pointer',
  contextmenu: 'pointer',
  mousedown: 'pointer',
  mouseup: 'pointer',
  pointerdown: 'pointer',
  pointerup: 'pointer',
  change: 'data',
  input: 'data',
  select: 'data',
  submit: 'data',
  focus: 'data',
  blur: 'data',
}

function eventTone(connection: EventConnection): EventTone {
  return EVENT_TONE_BY_NAME[connection.eventName] ?? 'other'
}

function eventIconStyle(connection: EventConnection): CSSProperties {
  return { '--event-color': EVENT_STYLE[eventTone(connection)].color }
}

const currentConnectionId = ref<string | undefined>(undefined)

const connectionList = computed<EventConnection[]>(() => {
  version.value
  return Object.values(document?.model.schema.connections ?? {})
})

const connectionIds = computed<string[]>(() => connectionList.value.map((item) => item.id))

// 连接可能被别处删除或被历史撤销；当前 id 失效时回落到第一条，避免三栏停在空引用上
watch(
  () => connectionIds.value.join('|'),
  () => {
    if (currentConnectionId.value && connectionIds.value.includes(currentConnectionId.value)) {
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

const selectedActionId = ref<string | undefined>(undefined)
const isCreatingEvent = ref(false)
const isActionPickerOpen = ref(false)
const eventNameDraft = ref('')
const creatorError = ref('')

/** 右栏同一时刻只允许展开一块编辑区，避免 260px 高的停靠区被两块表单同时占满 */
type SettingsSection = 'trigger' | 'action'
const expandedSection = ref<SettingsSection | undefined>(undefined)

// 切换连接时丢弃上一处选中与草稿：动作 id 只在所属连接内有意义，
// 带过去会让右栏展示另一条事件的动作。
watch(currentConnectionId, () => {
  selectedActionId.value = undefined
  isActionPickerOpen.value = false
  isCreatingEvent.value = false
  eventNameDraft.value = ''
  creatorError.value = ''
  expandedSection.value = undefined
})

function nodeLabel(nodeId: string): string {
  const node = document?.model.schema.nodes[nodeId]
  if (!node) return `已删除节点 ${nodeId}`
  return node.name || node.componentName || node.id
}

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
    [{ op: 'replace', path: connectionPath(connection.id, 'enabled'), value: target.checked }],
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

// ---------------------------------------------------------------------------
// 选中节点的事件声明
// ---------------------------------------------------------------------------

const selectedNodeId = computed<string | undefined>(() => {
  version.value
  return selection?.primary
})

const selectedNode = computed<NodeSchema | undefined>(() => {
  const id = selectedNodeId.value
  return id ? document?.model.schema.nodes[id] : undefined
})

/**
 * 物料服务契约里的 `MaterialContribution` 没有事件字段，但物料实现可能在运行时
 * 额外挂 `events`；这里做一次运行时探测，探测不到就回落到页面 schema 的
 * `components[].events`（唯一强类型来源），仍为空则让用户手填事件名。
 */
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

function isEventDefinition(value: unknown): value is EventDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    value.name.length > 0
  )
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

// ---------------------------------------------------------------------------
// 动作链
// ---------------------------------------------------------------------------

interface ChainItem {
  id: string
  action: ActionDeclaration | undefined
}

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

// 切换选中动作时收起右栏展开区：表单字段属于上一个动作，留在原地会让用户误编辑
watch(selectedActionId, () => {
  expandedSection.value = undefined
})

const selectedDefinition = computed<ActionDefinition | undefined>(() => {
  const action = selectedAction.value
  return action ? findActionDefinition(action.type) : undefined
})

const conditionText = computed<string>(() => {
  const condition = selectedAction.value?.condition
  return isExpressionString(condition) ? condition.raw : ''
})

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

/** 右栏第二行复用动作卡片同一套标题与参数摘要，两处口径不会分叉 */
const selectedActionSummary = computed<string>(() => {
  version.value
  const action = selectedAction.value
  if (action) return `${actionTitle(action)} ${actionParamSummary(action)}`
  return selectedActionId.value ? '动作已丢失' : '未选择动作'
})

function toggleSection(section: SettingsSection): void {
  expandedSection.value = expandedSection.value === section ? undefined : section
}

/**
 * 动作类型色与事件色一样属于「类型编码」，不随主题变化，集中在命名常量表里。
 * 动作卡片和右栏摘要共用同一张表，避免两处配色漂移。
 */
type ActionTone = 'state' | 'dataSource' | 'navigation' | 'ui' | 'flow' | 'plugin' | 'unknown'

const ACTION_STYLE: Record<ActionTone, { color: string }> = {
  state: { color: '#22d3a6' },
  dataSource: { color: '#a78bfa' },
  navigation: { color: '#2f8cff' },
  ui: { color: '#38bdf8' },
  flow: { color: '#f5a524' },
  plugin: { color: '#7f9bc2' },
  unknown: { color: '#ff6b81' },
}

const ACTION_TONE_BY_PREFIX: ReadonlyArray<{ prefix: string; tone: ActionTone }> = [
  { prefix: 'state.', tone: 'state' },
  { prefix: 'dataSource.', tone: 'dataSource' },
  { prefix: 'navigation.', tone: 'navigation' },
  { prefix: 'ui.', tone: 'ui' },
  { prefix: 'flow.', tone: 'flow' },
  { prefix: 'plugin.', tone: 'plugin' },
]

function actionTone(action: ActionDeclaration | undefined): ActionTone {
  if (!action) return 'unknown'
  const matched = ACTION_TONE_BY_PREFIX.find((item) => action.type.startsWith(item.prefix))
  return matched?.tone ?? 'unknown'
}

function actionCardStyle(action: ActionDeclaration | undefined): CSSProperties {
  const color = ACTION_STYLE[actionTone(action)].color
  return {
    '--action-color': color,
    // 8 位十六进制直接承载透明度（对应 #色22 / #色18），省去为每种类型再维护两份描边常量
    '--action-ring': `${color}22`,
    '--action-glow': `${color}18`,
  }
}

const TOAST_LEVEL_LABELS: Record<string, string> = {
  info: '提示',
  success: '成功',
  warning: '警告',
  error: '错误',
}

function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 卡片第二行的参数摘要必须按动作类型解释 config，而不是直接拼 JSON：
 * 用户需要一眼看懂「调哪个接口 / 跳哪里 / 什么级别」，原始字段名没有这个信息量。
 * 每种内置动作都在这张表里给出独立口径，模板只调用 summarize。
 */
const ACTION_PARAM_SUMMARY: Record<string, (config: Record<string, unknown>) => string> = {
  'state.set': () => '(setState)',
  'state.reset': () => '(resetState)',
  'dataSource.fetch': (config) => {
    const dataSourceId = configString(config, 'dataSourceId')
    return dataSourceId === '' ? '(调用接口)' : `(${dataSourceId})`
  },
  'navigation.go': (config) => {
    const to = configString(config, 'to')
    return to === '' ? '(跳转)' : `(${to})`
  },
  'ui.toast': (config) => {
    const level = configString(config, 'level')
    return `(${TOAST_LEVEL_LABELS[level] ?? TOAST_LEVEL_LABELS.info})`
  },
  'flow.condition': () => '(分支)',
  'flow.sequence': () => '(批量)',
  'plugin.invoke': (config) => {
    const service = configString(config, 'service')
    const method = configString(config, 'method')
    return service === '' || method === '' ? '(调用插件)' : `(${service}.${method})`
  },
}

function actionParamSummary(action: ActionDeclaration | undefined): string {
  if (!action) return '(未知动作)'
  const summarize = ACTION_PARAM_SUMMARY[action.type]
  return summarize ? summarize(action.config) : '(未知动作)'
}

function actionTitle(action: ActionDeclaration | undefined): string {
  if (!action) return '动作已丢失'
  // 用户显式命名优先；未命名时内置类型取协议标题，自定义类型只能退回 type
  return action.name || findActionDefinition(action.type)?.title || action.type || '未知动作'
}

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

// ---------------------------------------------------------------------------
// 动作配置
// ---------------------------------------------------------------------------

const jsonDraft = ref<string | null>(null)
const jsonDraftKey = ref<string | null>(null)
const jsonError = ref('')

watch(selectedActionId, () => {
  jsonDraft.value = null
  jsonDraftKey.value = null
  jsonError.value = ''
})

function inputValue(event: Event): string {
  const target = event.target
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return target.value
  }
  return ''
}

function commitActionName(event: Event): void {
  const action = selectedAction.value
  if (!action) return

  const name = inputValue(event).trim()
  if (name === '') {
    if (action.name === undefined) return
    commit([{ op: 'remove', path: actionPath(action.id, 'name') }], '修改动作配置')
    return
  }
  if (name === action.name) return

  commit([{ op: 'replace', path: actionPath(action.id, 'name'), value: name }], '修改动作配置')
}

function commitCondition(event: Event): void {
  const action = selectedAction.value
  if (!action) return

  const raw = inputValue(event).trim()
  if (raw === '') {
    if (action.condition === undefined) return
    commit([{ op: 'remove', path: actionPath(action.id, 'condition') }], '修改动作配置')
    return
  }
  if (isExpressionString(action.condition) && action.condition.raw === raw) return

  commit(
    [{ op: 'replace', path: actionPath(action.id, 'condition'), value: createExpression(raw) }],
    '修改动作配置',
  )
}

function fieldText(field: ActionFieldSchema): string {
  const value = selectedAction.value?.config[field.key]
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? ''
}

function fieldNumber(field: ActionFieldSchema): number | '' {
  const value = selectedAction.value?.config[field.key]
  return typeof value === 'number' ? value : ''
}

function fieldChecked(field: ActionFieldSchema): boolean {
  return selectedAction.value?.config[field.key] === true
}

function fieldSelectValue(field: ActionFieldSchema): string {
  const value = selectedAction.value?.config[field.key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function isUnlistedSelectValue(field: ActionFieldSchema): boolean {
  const value = fieldSelectValue(field)
  if (value === '') return false
  return !(field.options ?? []).some((option) => option.value === value)
}

function onFieldChange(field: ActionFieldSchema, event: Event): void {
  const action = selectedAction.value
  if (!action) return

  const target = event.target
  let value: unknown

  switch (field.kind) {
    case 'toggle':
      if (!(target instanceof HTMLInputElement)) return
      value = target.checked
      break
    case 'number': {
      if (!(target instanceof HTMLInputElement)) return
      if (target.value.trim() === '') return
      const parsed = Number(target.value)
      if (!Number.isFinite(parsed)) return
      value = parsed
      break
    }
    case 'select':
      if (!(target instanceof HTMLSelectElement) || target.value === '') return
      value = target.value
      break
    case 'text':
      if (!(target instanceof HTMLInputElement)) return
      value = target.value
      break
    case 'json':
      return
  }

  if (action.config[field.key] === value) return

  commit(
    [
      {
        op: 'replace',
        path: actionPath(action.id, 'config'),
        value: { ...action.config, [field.key]: value },
      },
    ],
    '修改动作配置',
  )
}

function jsonKeyOf(actionId: string, fieldKey: string): string {
  return `${actionId}:${fieldKey}`
}

function formatJsonValue(value: unknown): string {
  if (value === undefined) return ''
  return JSON.stringify(value, null, 2) ?? String(value)
}

function jsonText(field: ActionFieldSchema): string {
  const action = selectedAction.value
  if (!action) return ''
  const key = jsonKeyOf(action.id, field.key)
  if (jsonDraftKey.value === key && jsonDraft.value !== null) return jsonDraft.value
  return formatJsonValue(action.config[field.key])
}

function jsonErrorFor(field: ActionFieldSchema): string {
  const action = selectedAction.value
  if (!action) return ''
  return jsonDraftKey.value === jsonKeyOf(action.id, field.key) ? jsonError.value : ''
}

function onJsonInput(field: ActionFieldSchema, event: Event): void {
  const action = selectedAction.value
  if (!action) return
  jsonDraftKey.value = jsonKeyOf(action.id, field.key)
  jsonDraft.value = inputValue(event)
  jsonError.value = ''
}

function commitJson(field: ActionFieldSchema): void {
  const action = selectedAction.value
  if (!action) return

  const key = jsonKeyOf(action.id, field.key)
  const text =
    jsonDraftKey.value === key && jsonDraft.value !== null
      ? jsonDraft.value
      : formatJsonValue(action.config[field.key])

  let parsed: unknown
  try {
    parsed = text.trim() === '' ? undefined : JSON.parse(text)
  } catch (error) {
    // 半截 JSON 写进文档会让动作永久无法执行；保留草稿并就地报错，等用户改完再写
    jsonError.value =
      error instanceof Error ? `JSON 解析失败：${error.message}` : 'JSON 解析失败'
    return
  }

  const config: Record<string, unknown> = { ...action.config }
  if (parsed === undefined && text.trim() === '') delete config[field.key]
  else config[field.key] = parsed

  jsonError.value = ''
  jsonDraft.value = null
  jsonDraftKey.value = null
  commit(
    [{ op: 'replace', path: actionPath(action.id, 'config'), value: config }],
    '修改动作配置',
  )
}

// ---------------------------------------------------------------------------
// 校验诊断（只展示与当前连接及其动作相关的问题）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 写入与 id
// ---------------------------------------------------------------------------

function commit(patches: SchemaPatch[], label: string): void {
  if (!document || patches.length === 0) return
  document.apply(patches, { record: true, label })
}

/**
 * createId 的序号只保证进程内递增，持久化文档里可能已有同名前缀的 id；
 * 这里对现有键做一次去重，避免新动作/新连接覆盖旧数据。
 */
function nextId(prefix: string, taken: readonly string[]): string {
  const used = new Set(taken)
  let id = createId(prefix)
  while (used.has(id)) id = createId(prefix)
  return id
}
</script>

<template>
  <div class="lc-eventflow">
    <nav class="lc-eventflow__tabs" role="tablist" aria-label="底部面板">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        class="lc-eventflow__tab"
        :class="{ 'is-active': activeTab === tab.id }"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        <span class="lc-eventflow__tab-icon" :data-glyph="tab.glyph" aria-hidden="true"></span>
        {{ tab.label }}
      </button>
    </nav>

    <div v-if="!document" class="lc-eventflow__placeholder">文档服务未就绪</div>

    <div v-else-if="activeTab !== 'eventflow'" class="lc-eventflow__placeholder">
      <span>{{ activeTabLabel }} · 尚未接入</span>
      <span class="lc-eventflow__placeholder-hint">该页签将在后续版本提供</span>
    </div>

    <div v-else class="lc-eventflow__body">
      <!-- 左：事件列表 -->
      <aside class="lc-eventflow__events" aria-label="事件列表">
        <div class="lc-eventflow__column-head">
          <span class="lc-eventflow__column-title">页面事件</span>
          <button
            class="lc-eventflow__button"
            type="button"
            :aria-expanded="isCreatingEvent"
            @click="toggleEventCreator"
          >
            + 新建事件
          </button>
        </div>

        <div class="lc-eventflow__events-scroll">
          <div v-if="isCreatingEvent" class="lc-eventflow__creator">
            <span class="lc-eventflow__creator-label">页面事件</span>
            <button
              v-for="eventName in PAGE_EVENTS"
              :key="eventName"
              class="lc-eventflow__creator-option"
              type="button"
              @click="createConnection(PAGE_EVENT_SOURCE, eventName)"
            >
              <span>{{ pageEventLabel(eventName) }}</span>
              <code>{{ eventName }}</code>
            </button>

            <span class="lc-eventflow__creator-label">选中节点</span>
            <template v-if="selectedNode">
              <button
                v-for="definition in selectedNodeEvents"
                :key="definition.name"
                class="lc-eventflow__creator-option"
                type="button"
                @click="createSelectedNodeEvent(definition.name)"
              >
                <span>{{ definition.title || definition.name }}</span>
                <code>{{ definition.name }}</code>
              </button>

              <div class="lc-eventflow__creator-row">
                <input
                  v-model="eventNameDraft"
                  type="text"
                  placeholder="事件名，如 click"
                  @keydown.enter="createNodeEventFromDraft"
                />
                <button
                  class="lc-eventflow__button"
                  type="button"
                  @click="createNodeEventFromDraft"
                >
                  添加
                </button>
              </div>
              <p v-if="selectedNodeEvents.length === 0" class="lc-eventflow__creator-hint">
                物料未声明该组件事件，请手填事件名
              </p>
            </template>
            <p v-else class="lc-eventflow__creator-hint">先在画布中选中一个节点</p>
            <p v-if="creatorError" class="lc-eventflow__creator-error" role="alert">
              {{ creatorError }}
            </p>
          </div>

          <p v-if="connectionList.length === 0" class="lc-eventflow__empty">
            还没有事件，点击「+ 新建事件」开始
          </p>

          <ul v-else class="lc-eventflow__event-list">
            <li
              v-for="connection in connectionList"
              :key="connection.id"
              class="lc-eventflow__event-item"
              :class="{ 'is-active': connection.id === currentConnectionId }"
            >
              <button
                class="lc-eventflow__event-open"
                type="button"
                :title="connectionLabel(connection)"
                @click="selectConnection(connection.id)"
              >
                <span
                  class="lc-eventflow__event-icon"
                  :data-tone="eventTone(connection)"
                  :style="eventIconStyle(connection)"
                  aria-hidden="true"
                ></span>
                <span class="lc-eventflow__event-label">{{ connectionLabel(connection) }}</span>
                <span
                  class="lc-eventflow__event-count"
                  :title="`${connection.actionIds.length} 个动作`"
                >
                  {{ connection.actionIds.length }}
                </span>
              </button>

              <label
                class="lc-eventflow__switch"
                :title="connection.enabled ? '已启用' : '已停用'"
              >
                <input
                  type="checkbox"
                  :checked="connection.enabled"
                  :aria-label="`启用事件 ${connectionLabel(connection)}`"
                  @change="onConnectionEnabled(connection, $event)"
                />
                <span aria-hidden="true"></span>
              </label>
            </li>
          </ul>
        </div>
      </aside>

      <!-- 中：动作链 -->
      <section class="lc-eventflow__chain" aria-label="动作链">
        <div class="lc-eventflow__column-head">
          <span class="lc-eventflow__column-title">动作链</span>
          <span v-if="currentConnection" class="lc-eventflow__chain-hint">
            {{ connectionLabel(currentConnection) }}
            <em v-if="!currentConnection.enabled">已停用</em>
          </span>
        </div>

        <div v-if="!currentConnection" class="lc-eventflow__empty lc-eventflow__empty--block">
          选择左侧事件后编排动作
        </div>

        <template v-else>
          <ul v-if="currentIssues.length > 0" class="lc-eventflow__issues">
            <li
              v-for="(issue, index) in currentIssues"
              :key="`${index}-${issue.path}-${issue.message}`"
              class="lc-eventflow__issue"
              :class="`is-${issue.severity}`"
            >
              <span class="lc-eventflow__issue-level">
                {{ issue.severity === 'error' ? '错误' : '警告' }}
              </span>
              <span class="lc-eventflow__issue-message">{{ issue.message }}</span>
            </li>
          </ul>

          <div class="lc-eventflow__chain-scroll">
            <div class="lc-eventflow__chain-track">
              <template v-for="(item, index) in chainItems" :key="item.id">
                <article
                  class="lc-eventflow__card"
                  :class="{
                    'is-active': item.id === selectedActionId,
                    'is-broken': !item.action,
                  }"
                  :style="actionCardStyle(item.action)"
                  tabindex="0"
                  :aria-label="`${actionTitle(item.action)} ${actionParamSummary(item.action)}`"
                  @click="selectAction(item.id)"
                  @keydown.enter.self.prevent="selectAction(item.id)"
                >
                  <span class="lc-eventflow__card-body">
                    <span
                      class="lc-eventflow__card-icon"
                      :data-glyph="actionTone(item.action)"
                      aria-hidden="true"
                    ></span>
                    <span class="lc-eventflow__card-text">
                      <span class="lc-eventflow__card-title">
                        {{ actionTitle(item.action) }}
                      </span>
                      <span class="lc-eventflow__card-summary">
                        {{ actionParamSummary(item.action) }}
                      </span>
                    </span>
                  </span>

                  <span v-if="!item.action" class="lc-eventflow__card-broken">损坏</span>

                  <div class="lc-eventflow__card-tools" @click.stop>
                    <button
                      class="lc-eventflow__card-tool is-up"
                      type="button"
                      title="上移"
                      aria-label="上移动作"
                      :disabled="index === 0"
                      @click="moveAction(index, -1)"
                    ></button>
                    <button
                      class="lc-eventflow__card-tool is-down"
                      type="button"
                      title="下移"
                      aria-label="下移动作"
                      :disabled="index === chainItems.length - 1"
                      @click="moveAction(index, 1)"
                    ></button>
                    <button
                      class="lc-eventflow__card-tool is-remove"
                      type="button"
                      :title="item.action ? '删除动作' : '移除悬空引用'"
                      :aria-label="item.action ? '删除动作' : '移除悬空引用'"
                      @click="removeAction(item.id)"
                    ></button>
                  </div>
                </article>

                <span class="lc-eventflow__arrow" aria-hidden="true">→</span>
              </template>

              <button
                class="lc-eventflow__add-card"
                type="button"
                :aria-expanded="isActionPickerOpen"
                @click="isActionPickerOpen = !isActionPickerOpen"
              >
                + 添加动作
              </button>
            </div>
          </div>

          <div v-if="isActionPickerOpen" class="lc-eventflow__action-picker">
            <button
              v-for="definition in BUILTIN_ACTIONS"
              :key="definition.type"
              class="lc-eventflow__action-option"
              type="button"
              @click="addAction(definition.type)"
            >
              <span class="lc-eventflow__action-option-title">{{ definition.title }}</span>
              <span class="lc-eventflow__action-option-desc">{{ definition.description }}</span>
            </button>
          </div>
        </template>
      </section>

      <!-- 右：事件配置 -->
      <aside class="lc-eventflow__settings" aria-label="事件配置">
        <div class="lc-eventflow__column-head">
          <span class="lc-eventflow__column-title">事件配置</span>
        </div>

        <div v-if="!currentConnection" class="lc-eventflow__empty lc-eventflow__empty--block">
          选择左侧事件后查看配置
        </div>

        <div v-else class="lc-eventflow__settings-scroll">
          <div class="lc-eventflow__setting-row">
            <span class="lc-eventflow__setting-label">触发条件</span>
            <span class="lc-eventflow__setting-value" :title="triggerSummary">
              {{ triggerSummary }}
            </span>
            <button
              class="lc-eventflow__more"
              type="button"
              aria-label="编辑触发条件"
              title="编辑触发条件"
              :aria-expanded="expandedSection === 'trigger'"
              @click="toggleSection('trigger')"
            >
              …
            </button>
          </div>

          <div v-if="expandedSection === 'trigger'" class="lc-eventflow__expander">
            <label class="lc-eventflow__field">
              <span class="lc-eventflow__field-label">事件名</span>
              <input
                type="text"
                :value="currentConnection.eventName"
                @change="commitEventName"
              />
            </label>

            <label class="lc-eventflow__switch-row">
              <span>启用事件</span>
              <span class="lc-eventflow__switch">
                <input
                  type="checkbox"
                  :checked="currentConnection.enabled"
                  aria-label="启用当前事件"
                  @change="toggleCurrentConnectionEnabled($event)"
                />
                <span aria-hidden="true"></span>
              </span>
            </label>
          </div>

          <div class="lc-eventflow__setting-row">
            <span class="lc-eventflow__setting-label">执行动作</span>
            <span
              class="lc-eventflow__setting-value"
              :class="{ 'is-empty': !selectedActionId }"
              :title="selectedActionSummary"
            >
              {{ selectedActionSummary }}
            </span>
            <button
              class="lc-eventflow__more"
              type="button"
              aria-label="编辑执行动作"
              title="编辑执行动作"
              :aria-expanded="expandedSection === 'action'"
              @click="toggleSection('action')"
            >
              …
            </button>
          </div>

          <div v-if="expandedSection === 'action'" class="lc-eventflow__expander">
            <p v-if="!selectedActionId" class="lc-eventflow__empty">
              在中间动作链中点选一个动作
            </p>

            <p v-else-if="!selectedAction" class="lc-eventflow__error" role="alert">
              该动作定义已丢失，可在动作链中移除引用
            </p>

            <template v-else>
              <div class="lc-eventflow__action-head">
                <span class="lc-eventflow__badge">{{ selectedAction.type }}</span>
                <code class="lc-eventflow__action-id">{{ selectedAction.id }}</code>
              </div>

              <label class="lc-eventflow__field">
                <span class="lc-eventflow__field-label">名称</span>
                <input
                  type="text"
                  placeholder="缺省取动作类型标题"
                  :value="selectedAction.name ?? ''"
                  @change="commitActionName"
                />
              </label>

              <template v-if="selectedDefinition">
                <template v-for="field in selectedDefinition.fields" :key="field.key">
                  <label v-if="field.kind === 'toggle'" class="lc-eventflow__check">
                    <input
                      type="checkbox"
                      :checked="fieldChecked(field)"
                      @change="onFieldChange(field, $event)"
                    />
                    <span>{{ field.label }}</span>
                  </label>

                  <label v-else class="lc-eventflow__field">
                    <span class="lc-eventflow__field-label">
                      {{ field.label }}
                      <em v-if="field.required" aria-hidden="true">*</em>
                    </span>

                    <select
                      v-if="field.kind === 'select'"
                      :value="fieldSelectValue(field)"
                      @change="onFieldChange(field, $event)"
                    >
                      <option value="" disabled>未设置</option>
                      <option
                        v-for="option in field.options ?? []"
                        :key="option.value"
                        :value="option.value"
                      >
                        {{ option.label }}
                      </option>
                      <option
                        v-if="isUnlistedSelectValue(field)"
                        :value="fieldSelectValue(field)"
                      >
                        {{ fieldSelectValue(field) }}
                      </option>
                    </select>

                    <textarea
                      v-else-if="field.kind === 'json'"
                      rows="4"
                      spellcheck="false"
                      :placeholder="field.placeholder ?? '{ }'"
                      :value="jsonText(field)"
                      @input="onJsonInput(field, $event)"
                      @change="commitJson(field)"
                    />

                    <input
                      v-else-if="field.kind === 'number'"
                      type="number"
                      :placeholder="field.placeholder"
                      :value="fieldNumber(field)"
                      @change="onFieldChange(field, $event)"
                    />

                    <input
                      v-else
                      type="text"
                      :placeholder="field.placeholder"
                      :value="fieldText(field)"
                      @change="onFieldChange(field, $event)"
                    />

                    <span
                      v-if="field.kind === 'json' && jsonErrorFor(field)"
                      class="lc-eventflow__error"
                      role="alert"
                    >
                      {{ jsonErrorFor(field) }}
                    </span>
                  </label>
                </template>
              </template>

              <p v-else class="lc-eventflow__hint">
                自定义动作类型「{{ selectedAction.type }}」，没有可渲染的内置字段
              </p>

              <label class="lc-eventflow__field">
                <span class="lc-eventflow__field-label">执行条件</span>
                <textarea
                  rows="2"
                  spellcheck="false"
                  placeholder="留空表示无条件执行，如 {{ count > 0 }}"
                  :value="conditionText"
                  @change="commitCondition"
                />
              </label>
            </template>
          </div>

          <div class="lc-eventflow__setting-row">
            <span class="lc-eventflow__setting-label">启用事件</span>
            <span class="lc-eventflow__setting-value"></span>
            <label
              class="lc-eventflow__switch"
              :title="currentConnection.enabled ? '已启用' : '已停用'"
            >
              <input
                type="checkbox"
                :checked="currentConnection.enabled"
                aria-label="启用当前事件"
                @change="toggleCurrentConnectionEnabled($event)"
              />
              <span aria-hidden="true"></span>
            </label>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.lc-eventflow {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--lc-surface, #12151d);
  color: var(--lc-text, #e6ecf7);
  font-size: 12px;
}

/* ---------------------------------------------------------------------------
 * 页签
 * ------------------------------------------------------------------------- */

.lc-eventflow__tabs {
  display: flex;
  flex: none;
  gap: 2px;
  padding: 0 8px;
  overflow-x: auto;
  border-bottom: 1px solid var(--lc-border, #262b36);
}

.lc-eventflow__tab {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--lc-text-secondary, #8c96a8);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}

.lc-eventflow__tab:hover {
  color: var(--lc-text, #e6ecf7);
}

.lc-eventflow__tab.is-active {
  border-bottom-color: var(--lc-accent, #4cc9f0);
  color: var(--lc-accent, #4cc9f0);
}

/* 页签字形全部用 CSS 几何形状描述，避免为 5 个小图标引入图标库 */
.lc-eventflow__tab-icon {
  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: 12px;
  height: 12px;
  color: currentColor;
}

.lc-eventflow__tab-icon::before,
.lc-eventflow__tab-icon::after {
  content: '';
  grid-area: 1 / 1;
}

.lc-eventflow__tab-icon[data-glyph='bolt']::before {
  width: 12px;
  height: 12px;
  background: currentColor;
  clip-path: polygon(58% 0, 12% 56%, 46% 56%, 36% 100%, 90% 42%, 54% 42%);
}

.lc-eventflow__tab-icon[data-glyph='chain']::before,
.lc-eventflow__tab-icon[data-glyph='chain']::after {
  width: 6px;
  height: 6px;
  box-sizing: border-box;
  border: 1.2px solid currentColor;
  border-radius: 50%;
}

.lc-eventflow__tab-icon[data-glyph='chain']::before {
  transform: translate(-2px, -1px);
}

.lc-eventflow__tab-icon[data-glyph='chain']::after {
  transform: translate(2px, 1px);
}

.lc-eventflow__tab-icon[data-glyph='swatch']::before {
  width: 7px;
  height: 7px;
  box-sizing: border-box;
  border: 1.2px solid currentColor;
  border-radius: 2px;
  transform: translate(-2px, -2px);
}

.lc-eventflow__tab-icon[data-glyph='swatch']::after {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.75;
  transform: translate(2px, 2px);
}

.lc-eventflow__tab-icon[data-glyph='code']::before,
.lc-eventflow__tab-icon[data-glyph='code']::after {
  width: 5px;
  height: 5px;
  box-sizing: border-box;
  border-top: 1.2px solid currentColor;
  border-left: 1.2px solid currentColor;
}

.lc-eventflow__tab-icon[data-glyph='code']::before {
  transform: translate(-2px, 0) rotate(-45deg);
}

.lc-eventflow__tab-icon[data-glyph='code']::after {
  transform: translate(2px, 0) rotate(135deg);
}

.lc-eventflow__tab-icon[data-glyph='wave']::before {
  width: 12px;
  height: 12px;
  background: currentColor;
  clip-path: polygon(
    0 62%,
    25% 18%,
    50% 62%,
    75% 18%,
    100% 62%,
    100% 92%,
    75% 48%,
    50% 92%,
    25% 48%,
    0 92%
  );
}

.lc-eventflow__placeholder {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 0;
  padding: 16px;
  color: var(--lc-text-secondary, #8c96a8);
  text-align: center;
}

.lc-eventflow__placeholder-hint {
  font-size: 11px;
  opacity: 0.75;
}

/* ---------------------------------------------------------------------------
 * 三栏骨架
 * ------------------------------------------------------------------------- */

.lc-eventflow__body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.lc-eventflow__events,
.lc-eventflow__chain,
.lc-eventflow__settings {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.lc-eventflow__events {
  flex: none;
  width: 200px;
  border-right: 1px solid var(--lc-border, #262b36);
}

.lc-eventflow__chain {
  position: relative;
  flex: 1;
  min-width: 0;
  padding: 0 10px;
}

.lc-eventflow__settings {
  flex: none;
  width: 260px;
  border-left: 1px solid var(--lc-border, #262b36);
}

.lc-eventflow__column-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 32px;
  padding: 0 10px;
}

.lc-eventflow__column-title {
  color: var(--lc-text-secondary, #8c96a8);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
}

.lc-eventflow__events-scroll,
.lc-eventflow__settings-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.lc-eventflow__settings-scroll {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 8px 10px;
}

/* 右栏用「标签 + 值 + 编辑入口」三行摘要，完整表单只在展开区里出现 */
.lc-eventflow__setting-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 2px 0 6px;
  border-radius: 8px;
}

.lc-eventflow__setting-row:hover {
  background: var(--lc-surface-sunken, rgba(7, 21, 40, 0.55));
}

.lc-eventflow__setting-label {
  flex: none;
  width: 48px;
  color: var(--lc-text-muted, #5f7ea6);
  font-size: 11px;
}

.lc-eventflow__setting-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--lc-text, #dbeafe);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-eventflow__setting-value.is-empty {
  color: var(--lc-text-muted, #5f7ea6);
}

.lc-eventflow__more {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: none;
  color: var(--lc-text-secondary, #7f9bc2);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.lc-eventflow__more:hover,
.lc-eventflow__more[aria-expanded='true'] {
  border-color: var(--lc-border, rgba(64, 150, 255, 0.18));
  background: var(--lc-accent-soft, rgba(47, 140, 255, 0.14));
  color: var(--lc-accent-bright, #37b6ff);
}

.lc-eventflow__expander {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 0 6px;
  padding: 8px;
  border: 1px solid var(--lc-border, rgba(64, 150, 255, 0.18));
  border-radius: 10px;
  background: var(--lc-surface-sunken, rgba(7, 21, 40, 0.55));
}

/* ---------------------------------------------------------------------------
 * 事件列表
 * ------------------------------------------------------------------------- */

.lc-eventflow__button {
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--lc-border, #333a48);
  border-radius: 6px;
  background: var(--lc-surface-sunken, #0c0f16);
  color: var(--lc-text, #e6ecf7);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.lc-eventflow__button:hover {
  border-color: var(--lc-accent, #4cc9f0);
  color: var(--lc-accent, #4cc9f0);
}

.lc-eventflow__creator {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 10px 10px;
  border-bottom: 1px solid var(--lc-border, #262b36);
  background: var(--lc-surface-sunken, #0c0f16);
}

.lc-eventflow__creator-label {
  margin-top: 2px;
  color: var(--lc-text-secondary, #8c96a8);
  font-size: 10px;
}

.lc-eventflow__creator-option {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 7px;
  border: 1px solid var(--lc-border, #333a48);
  border-radius: 6px;
  background: var(--lc-surface, #12151d);
  color: var(--lc-text, #e6ecf7);
  font: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.lc-eventflow__creator-option:hover {
  border-color: var(--lc-accent, #4cc9f0);
}

.lc-eventflow__creator-option code,
.lc-eventflow__action-id {
  color: var(--lc-text-secondary, #8c96a8);
  font-family: monospace;
  font-size: 10px;
}

.lc-eventflow__creator-row {
  display: flex;
  gap: 5px;
  margin-top: 2px;
}

.lc-eventflow__creator-row input {
  flex: 1;
  min-width: 0;
  height: 24px;
  box-sizing: border-box;
  padding: 0 6px;
  border: 1px solid var(--lc-border, #333a48);
  border-radius: 6px;
  background: var(--lc-surface, #12151d);
  color: var(--lc-text, #e6ecf7);
  font: inherit;
  font-size: 11px;
}

.lc-eventflow__creator-hint {
  margin: 0;
  color: var(--lc-text-secondary, #8c96a8);
  font-size: 10px;
  line-height: 1.45;
}

.lc-eventflow__creator-error {
  margin: 0;
  color: var(--lc-danger, #ff5c7a);
  font-size: 10px;
}

.lc-eventflow__event-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0;
  padding: 6px;
  list-style: none;
}

.lc-eventflow__event-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 6px;
  border: 1px solid transparent;
  border-radius: 7px;
}

.lc-eventflow__event-item:hover {
  background: var(--lc-surface-sunken, #0c0f16);
}

.lc-eventflow__event-item.is-active {
  border-color: color-mix(in srgb, var(--lc-accent, #4cc9f0) 45%, transparent);
  background: color-mix(in srgb, var(--lc-accent, #4cc9f0) 12%, transparent);
}

.lc-eventflow__event-open {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 4px 2px 4px 6px;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

/* 图标块用事件种类色着色；字形只是装饰，语义由左侧事件名承担 */
.lc-eventflow__event-icon {
  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  background: color-mix(
    in srgb,
    var(--event-color, var(--lc-accent, #2f8cff)) 18%,
    transparent
  );
  color: var(--event-color, var(--lc-accent, #2f8cff));
}

.lc-eventflow__event-icon::before,
.lc-eventflow__event-icon::after {
  content: '';
  grid-area: 1 / 1;
}

.lc-eventflow__event-icon[data-tone='pageLoad']::before {
  width: 0;
  height: 0;
  margin-left: 1px;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid currentColor;
}

.lc-eventflow__event-icon[data-tone='pageUnload']::before {
  width: 6px;
  height: 6px;
  box-sizing: border-box;
  border: 1.2px solid currentColor;
  border-radius: 1px;
}

.lc-eventflow__event-icon[data-tone='pointer']::before {
  width: 7px;
  height: 9px;
  background: currentColor;
  clip-path: polygon(0 0, 0 100%, 30% 72%, 50% 100%, 68% 88%, 48% 62%, 100% 62%);
}

.lc-eventflow__event-icon[data-tone='data']::before {
  width: 8px;
  height: 1.5px;
  border-radius: 1px;
  background: currentColor;
  box-shadow:
    0 -3px 0 currentColor,
    0 3px 0 currentColor;
}

.lc-eventflow__event-icon[data-tone='other']::before {
  width: 6px;
  height: 6px;
  border-radius: 1px;
  background: currentColor;
  transform: rotate(45deg);
}

.lc-eventflow__event-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-eventflow__event-item.is-active .lc-eventflow__event-label {
  color: var(--lc-accent, #4cc9f0);
}

/* 动作数只留数字，完整语义放在 title 里，避免窄列表被「N 个动作」挤满 */
.lc-eventflow__event-count {
  flex: none;
  min-width: 12px;
  color: var(--lc-text-muted, #5f7ea6);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* ---------------------------------------------------------------------------
 * 开关
 * ------------------------------------------------------------------------- */

.lc-eventflow__switch {
  position: relative;
  display: inline-flex;
  flex: none;
  width: 28px;
  height: 16px;
}

.lc-eventflow__switch input {
  position: absolute;
  inset: 0;
  margin: 0;
  cursor: pointer;
  opacity: 0;
}

.lc-eventflow__switch > span {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border: 1px solid var(--lc-border-strong, #3d4658);
  border-radius: 999px;
  background: var(--lc-surface-sunken, #0c0f16);
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.lc-eventflow__switch > span::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--lc-text-secondary, #8c96a8);
  transition:
    transform 0.15s ease,
    background-color 0.15s ease;
}

.lc-eventflow__switch input:checked + span {
  border-color: var(--lc-accent, #4cc9f0);
  background: color-mix(in srgb, var(--lc-accent, #4cc9f0) 22%, transparent);
}

.lc-eventflow__switch input:checked + span::after {
  transform: translateX(12px);
  background: var(--lc-accent, #4cc9f0);
}

.lc-eventflow__switch input:focus-visible + span {
  outline: 2px solid var(--lc-accent, #4cc9f0);
  outline-offset: 1px;
}

.lc-eventflow__switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--lc-text-secondary, #8c96a8);
  font-size: 11px;
}

/* ---------------------------------------------------------------------------
 * 动作链
 * ------------------------------------------------------------------------- */

.lc-eventflow__chain-hint {
  min-width: 0;
  overflow: hidden;
  color: var(--lc-text-secondary, #8c96a8);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-eventflow__chain-hint em {
  margin-left: 6px;
  color: var(--lc-guide, #f5b942);
  font-style: normal;
}

.lc-eventflow__issues {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 3px;
  max-height: 54px;
  margin: 0 0 6px;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.lc-eventflow__issue {
  display: flex;
  gap: 6px;
  padding: 3px 6px;
  border-left: 2px solid var(--lc-border-strong, #3d4658);
  border-radius: 4px;
  background: var(--lc-surface-sunken, #0c0f16);
  font-size: 10px;
  line-height: 1.4;
}

.lc-eventflow__issue.is-error {
  border-left-color: var(--lc-danger, #ff5c7a);
}

.lc-eventflow__issue.is-warning {
  border-left-color: var(--lc-guide, #f5b942);
}

.lc-eventflow__issue-level {
  flex: none;
  font-weight: 600;
}

.lc-eventflow__issue.is-error .lc-eventflow__issue-level {
  color: var(--lc-danger, #ff5c7a);
}

.lc-eventflow__issue.is-warning .lc-eventflow__issue-level {
  color: var(--lc-guide, #f5b942);
}

.lc-eventflow__issue-message {
  min-width: 0;
  overflow: hidden;
  color: var(--lc-text, #e6ecf7);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-eventflow__chain-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 2px 2px 10px;
}

.lc-eventflow__chain-track {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: max-content;
  min-height: 80px;
  height: 100%;
}

.lc-eventflow__card {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  box-sizing: border-box;
  width: 176px;
  height: 72px;
  padding: 8px 12px;
  border: 1px solid
    color-mix(in srgb, var(--action-color, var(--lc-accent, #2f8cff)) 45%, transparent);
  border-radius: 14px;
  background: var(--lc-panel-glass, rgba(10, 30, 61, 0.72));
  box-shadow:
    0 0 0 1px var(--action-ring, transparent),
    0 8px 20px var(--action-glow, transparent);
  color: var(--lc-text, #dbeafe);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    background-color 0.15s ease;
}

.lc-eventflow__card:hover {
  border-color: var(--action-color, var(--lc-accent, #2f8cff));
}

.lc-eventflow__card.is-active {
  border-color: var(--action-color, var(--lc-accent, #2f8cff));
  /* 用内阴影补一层描边，视觉上 2px 加粗但不改变盒模型，避免选中时内容跳动 */
  box-shadow:
    inset 0 0 0 1px var(--action-color, var(--lc-accent, #2f8cff)),
    0 0 0 2px
      color-mix(in srgb, var(--action-color, var(--lc-accent, #2f8cff)) 38%, transparent),
    0 10px 26px
      color-mix(in srgb, var(--action-color, var(--lc-accent, #2f8cff)) 32%, transparent);
}

.lc-eventflow__card.is-broken {
  background: var(--lc-danger-surface, rgba(255, 107, 129, 0.12));
}

.lc-eventflow__card-body {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-width: 0;
}

.lc-eventflow__card-icon {
  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: color-mix(
    in srgb,
    var(--action-color, var(--lc-accent, #2f8cff)) 16%,
    transparent
  );
  color: var(--action-color, var(--lc-accent, #2f8cff));
}

.lc-eventflow__card-icon::before,
.lc-eventflow__card-icon::after {
  content: '';
  grid-area: 1 / 1;
}

/* 每种动作族一个简化几何字形，只承担辨识作用，不引入图标库 */
.lc-eventflow__card-icon[data-glyph='state']::before {
  width: 12px;
  height: 12px;
  box-sizing: border-box;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.lc-eventflow__card-icon[data-glyph='state']::after {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
}

.lc-eventflow__card-icon[data-glyph='dataSource']::before {
  width: 13px;
  height: 1.5px;
  border-radius: 1px;
  background: currentColor;
  box-shadow:
    0 -4px 0 currentColor,
    0 4px 0 currentColor;
}

.lc-eventflow__card-icon[data-glyph='navigation']::before {
  width: 7px;
  height: 7px;
  box-sizing: border-box;
  border-top: 1.5px solid currentColor;
  border-right: 1.5px solid currentColor;
  transform: rotate(45deg);
}

.lc-eventflow__card-icon[data-glyph='ui']::before {
  width: 15px;
  height: 11px;
  box-sizing: border-box;
  border: 1.5px solid currentColor;
  border-radius: 4px;
}

.lc-eventflow__card-icon[data-glyph='ui']::after {
  width: 0;
  height: 0;
  margin-top: 10px;
  margin-left: 5px;
  border-top: 5px solid currentColor;
  border-right: 4px solid transparent;
}

.lc-eventflow__card-icon[data-glyph='flow']::before,
.lc-eventflow__card-icon[data-glyph='flow']::after {
  width: 1.5px;
  height: 9px;
  border-radius: 1px;
  background: currentColor;
  transform-origin: bottom center;
}

.lc-eventflow__card-icon[data-glyph='flow']::before {
  transform: translate(-2.5px, 2px) rotate(-35deg);
}

.lc-eventflow__card-icon[data-glyph='flow']::after {
  transform: translate(2.5px, 2px) rotate(35deg);
}

.lc-eventflow__card-icon[data-glyph='plugin']::before {
  width: 10px;
  height: 10px;
  box-sizing: border-box;
  border: 1.5px solid currentColor;
  border-radius: 2px;
  transform: translate(-3px, -3px);
}

.lc-eventflow__card-icon[data-glyph='plugin']::after {
  width: 10px;
  height: 10px;
  box-sizing: border-box;
  border: 1.5px solid currentColor;
  border-radius: 2px;
  transform: translate(3px, 3px);
}

.lc-eventflow__card-icon[data-glyph='unknown']::before {
  width: 2px;
  height: 8px;
  border-radius: 1px;
  background: currentColor;
  transform: translateY(-3px);
}

.lc-eventflow__card-icon[data-glyph='unknown']::after {
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: currentColor;
  transform: translateY(5px);
}

.lc-eventflow__card-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.lc-eventflow__card-title {
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-eventflow__card-summary {
  overflow: hidden;
  color: var(--lc-text-secondary, #7f9bc2);
  font-size: 12px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-eventflow__card-broken {
  position: absolute;
  right: 8px;
  bottom: 5px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--lc-danger-surface, rgba(255, 107, 129, 0.12));
  color: var(--lc-danger, #ff6b81);
  font-size: 9px;
  line-height: 14px;
}

/* 操作按钮收进 hover / focus：它们常驻会挤占 176px 卡片的正文宽度，标题必然被截断 */
.lc-eventflow__card-tools {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  gap: 1px;
  padding: 1px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--lc-surface, #0a1b33) 82%, transparent);
  opacity: 0;
  /* 隐藏时不接收指针事件，否则不可见的按钮会抢走卡片本体的点击（触屏尤其明显） */
  pointer-events: none;
  transition: opacity 0.12s ease;
}

.lc-eventflow__card:hover .lc-eventflow__card-tools,
.lc-eventflow__card:focus-within .lc-eventflow__card-tools {
  opacity: 1;
  pointer-events: auto;
}

.lc-eventflow__card-tool {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  color: var(--lc-text-secondary, #7f9bc2);
  cursor: pointer;
}

.lc-eventflow__card-tool::before,
.lc-eventflow__card-tool::after {
  content: '';
  grid-area: 1 / 1;
}

.lc-eventflow__card-tool.is-up::before {
  width: 0;
  height: 0;
  border-right: 3px solid transparent;
  border-bottom: 5px solid currentColor;
  border-left: 3px solid transparent;
}

.lc-eventflow__card-tool.is-down::before {
  width: 0;
  height: 0;
  border-top: 5px solid currentColor;
  border-right: 3px solid transparent;
  border-left: 3px solid transparent;
}

.lc-eventflow__card-tool.is-remove::before,
.lc-eventflow__card-tool.is-remove::after {
  width: 9px;
  height: 1px;
  background: currentColor;
}

.lc-eventflow__card-tool.is-remove::before {
  transform: rotate(45deg);
}

.lc-eventflow__card-tool.is-remove::after {
  transform: rotate(-45deg);
}

.lc-eventflow__card-tool:hover:not(:disabled) {
  border-color: var(--lc-border, rgba(64, 150, 255, 0.18));
  background: var(--lc-accent-soft, rgba(47, 140, 255, 0.14));
  color: var(--lc-text, #dbeafe);
}

.lc-eventflow__card-tool.is-remove:hover:not(:disabled) {
  color: var(--lc-danger, #ff6b81);
}

.lc-eventflow__card-tool:disabled {
  cursor: default;
  opacity: 0.3;
}

.lc-eventflow__arrow {
  display: flex;
  flex: none;
  align-items: center;
  color: var(--lc-text-muted, #5f7ea6);
  font-size: 12px;
  line-height: 1;
}

.lc-eventflow__add-card {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 176px;
  height: 72px;
  border: 1px dashed var(--lc-border-strong, rgba(64, 150, 255, 0.36));
  border-radius: 14px;
  background: transparent;
  color: var(--lc-text-secondary, #7f9bc2);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    color 0.15s ease;
}

.lc-eventflow__add-card:hover {
  border-color: var(--lc-accent, #2f8cff);
  color: var(--lc-accent-bright, #37b6ff);
}

.lc-eventflow__action-picker {
  position: absolute;
  top: 36px;
  right: 10px;
  left: 10px;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 6px;
  max-height: calc(100% - 44px);
  box-sizing: border-box;
  padding: 8px;
  overflow-y: auto;
  border: 1px solid var(--lc-border-strong, #3d4658);
  border-radius: var(--lc-radius-sm, 8px);
  background: var(--lc-surface, #12151d);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
}

.lc-eventflow__action-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  border: 1px solid var(--lc-border, #333a48);
  border-radius: 7px;
  background: var(--lc-surface-sunken, #0c0f16);
  color: var(--lc-text, #e6ecf7);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.lc-eventflow__action-option:hover {
  border-color: var(--lc-accent, #4cc9f0);
}

.lc-eventflow__action-option-title {
  font-size: 11px;
  font-weight: 600;
}

.lc-eventflow__action-option-desc {
  color: var(--lc-text-secondary, #8c96a8);
  font-size: 10px;
  line-height: 1.4;
}

/* ---------------------------------------------------------------------------
 * 事件配置
 * ------------------------------------------------------------------------- */

.lc-eventflow__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin: 0;
}

.lc-eventflow__field-label {
  color: var(--lc-text-secondary, #8c96a8);
  font-size: 10px;
}

.lc-eventflow__field-label em {
  margin-left: 2px;
  color: var(--lc-danger, #ff5c7a);
  font-style: normal;
}

.lc-eventflow__field input[type='text'],
.lc-eventflow__field input[type='number'],
.lc-eventflow__field select,
.lc-eventflow__field textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--lc-border, #333a48);
  border-radius: 6px;
  background: var(--lc-surface-sunken, #0c0f16);
  color: var(--lc-text, #e6ecf7);
  font: inherit;
  font-size: 11px;
}

.lc-eventflow__field input[type='text'],
.lc-eventflow__field input[type='number'],
.lc-eventflow__field select {
  height: 26px;
}

.lc-eventflow__field input[readonly] {
  color: var(--lc-text-secondary, #8c96a8);
  cursor: default;
}

.lc-eventflow__field textarea {
  min-height: 46px;
  font-family: monospace;
  line-height: 1.5;
  resize: vertical;
}

.lc-eventflow__field input:focus,
.lc-eventflow__field select:focus,
.lc-eventflow__field textarea:focus {
  border-color: var(--lc-accent, #4cc9f0);
  outline: 1px solid var(--lc-accent, #4cc9f0);
}

.lc-eventflow__check {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--lc-text, #e6ecf7);
  font-size: 11px;
}

.lc-eventflow__check input {
  margin: 0;
  accent-color: var(--lc-accent, #4cc9f0);
}

.lc-eventflow__action-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.lc-eventflow__badge {
  flex: none;
  max-width: 60%;
  overflow: hidden;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--lc-accent, #4cc9f0) 14%, transparent);
  color: var(--lc-accent, #4cc9f0);
  font-family: monospace;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-eventflow__empty {
  margin: 0;
  padding: 10px;
  border-radius: var(--lc-radius-sm, 8px);
  background: var(--lc-surface-sunken, #0c0f16);
  color: var(--lc-text-secondary, #8c96a8);
  font-size: 11px;
  line-height: 1.5;
}

.lc-eventflow__empty--block {
  margin: 0 10px;
}

.lc-eventflow__events-scroll > .lc-eventflow__empty {
  margin: 8px;
}

.lc-eventflow__settings-scroll > .lc-eventflow__empty--block {
  margin: 0;
}

.lc-eventflow__chain > .lc-eventflow__empty--block {
  margin: 0;
}

.lc-eventflow__hint {
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--lc-surface-sunken, #0c0f16);
  color: var(--lc-text-secondary, #8c96a8);
  font-size: 10px;
  line-height: 1.5;
}

.lc-eventflow__error {
  margin: 0;
  padding: 5px 7px;
  border-radius: 6px;
  background: var(--lc-danger-surface, rgba(255, 92, 122, 0.12));
  color: var(--lc-danger, #ff5c7a);
  font-size: 10px;
  line-height: 1.45;
}

/* ---------------------------------------------------------------------------
 * 焦点与减少动效
 * ------------------------------------------------------------------------- */

.lc-eventflow__tab:focus-visible,
.lc-eventflow__button:focus-visible,
.lc-eventflow__creator-option:focus-visible,
.lc-eventflow__event-open:focus-visible,
.lc-eventflow__card:focus-visible,
.lc-eventflow__card-tool:focus-visible,
.lc-eventflow__more:focus-visible,
.lc-eventflow__add-card:focus-visible,
.lc-eventflow__action-option:focus-visible {
  outline: 2px solid var(--lc-accent, #4cc9f0);
  outline-offset: 1px;
}

/* 卡片焦点环跟随自身类型色，选中态与键盘焦点才不会互相掩盖 */
.lc-eventflow__card:focus-visible {
  outline-color: var(--action-color, var(--lc-accent, #2f8cff));
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .lc-eventflow__switch > span,
  .lc-eventflow__switch > span::after,
  .lc-eventflow__card,
  .lc-eventflow__card-tools,
  .lc-eventflow__add-card {
    transition: none;
  }
}
</style>
