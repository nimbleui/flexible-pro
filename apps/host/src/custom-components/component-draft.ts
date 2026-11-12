import type { JsonSchema } from '@lc/contracts'
import type {
  ComponentSchema,
  EventDefinition,
  EventParameter,
  PropDefinition,
  PropType,
  PropValue,
  SlotDefinition,
  SlotRegion,
} from '@lc/schema'

/**
 * 自定义组件定义表的编辑草稿。
 *
 * 只承载需要人填的四块：元信息、对外属性、对外事件、插槽声明。节点图不在这里——
 * 蓝图由画布装载的文档服务持有，保存时按文档快照原样写回定义。如果草稿里再存一份
 * 节点表，就会出现「表单里的父子」和「画布上的层级」两套真相。
 */

/** 属性定义行 */
export interface PropDraft {
  /** 属性名，蓝图表达式里以 `props.<name>` 访问 */
  name: string
  /** 属性面板显示标题 */
  title: string
  /** 属性类型；只允许可在属性面板填值的类型 */
  type: PropType
  /** 默认值文本；解析口径随类型变化，见 `parsePropDefault` */
  defaultText: string
  /** 枚举选项文本，每行 `值` 或 `值=标签`；仅 type 为 enum 时使用 */
  optionsText: string
}

/** 对外事件行 */
export interface EventDraft {
  /** 事件名，页面事件流按它接线 */
  name: string
  /** 显示标题 */
  title: string
  /** 用途说明 */
  description: string
  /** 参数列表文本，每行 `名称` 或 `名称=类型` */
  paramsText: string
}

/** 插槽声明行 */
export interface SlotDraft {
  /** 插槽名，实例节点按它归档内容（`node.slots[<name>]`） */
  name: string
  /** 显示标题 */
  title: string
  /** 用途说明 */
  description: string
  /** 允许放入的物料名，逗号分隔；留空表示不限 */
  acceptsText: string
  /** 最多容纳的子节点数文本；留空或 0 表示不限 */
  maxText: string
  /** 命中区域左上角 X（相对容器宽度的百分比文本）；四项不全则整槽覆盖全屏 */
  x: string
  /** 命中区域左上角 Y（相对容器高度的百分比文本） */
  y: string
  /** 命中区域宽度（百分比文本） */
  width: string
  /** 命中区域高度（百分比文本） */
  height: string
}

/** 自定义组件定义草稿 */
export interface CustomComponentDraft {
  /** 目标条目 id；缺省表示新建 */
  id?: string
  /** 组件名，同时是画布物料名 */
  name: string
  /** 展示标题 */
  title: string
  /** 物料面板分组 */
  group: string
  /** 图标名 */
  icon: string
  /** 版本号 */
  version: string
  /** 说明 */
  description: string
  /** 属性定义行 */
  props: PropDraft[]
  /** 对外事件行 */
  events: EventDraft[]
  /** 插槽声明行 */
  slots: SlotDraft[]
}

/** 校验错误定位到的字段；表单按字段分组展示 */
export type DraftIssueField =
  'name' | 'title' | 'group' | 'version' | 'props' | 'events' | 'slots'

/** 一条草稿校验错误 */
export interface DraftIssue {
  /** 出错字段，表单据此把错误挂到对应区块下方 */
  field: DraftIssueField
  /** 面向用户的中文说明；行级错误在文案里点名属性名 */
  message: string
}

/**
 * 属性类型可选项。
 *
 * 不含 `event` / `slot` / `function`：这三类不是「在属性面板里填一个值」的属性，
 * 复合组件也没有把它们透传出去的渲染路径，列出来只会产出画布上无法使用的定义。
 */
export const SELECTABLE_PROP_TYPES: readonly PropType[] = [
  'string',
  'number',
  'boolean',
  'color',
  'enum',
  'object',
  'array',
]

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/
const VERSION_PATTERN = /^\d+(\.\d+){1,2}$/

/** 新建属性行的空值 */
export const EMPTY_PROP_DRAFT: Readonly<PropDraft> = Object.freeze({
  name: '',
  title: '',
  type: 'string',
  defaultText: '',
  optionsText: '',
})

/** 新建事件行的空值 */
export const EMPTY_EVENT_DRAFT: Readonly<EventDraft> = Object.freeze({
  name: '',
  title: '',
  description: '',
  paramsText: '',
})

/** 新建插槽行的空值；区域留空表示整槽覆盖容器 */
export const EMPTY_SLOT_DRAFT: Readonly<SlotDraft> = Object.freeze({
  name: '',
  title: '',
  description: '',
  acceptsText: '',
  maxText: '',
  x: '',
  y: '',
  width: '',
  height: '',
})

/** 新建组件的空草稿；分组给默认值，省掉一次必填输入 */
export const EMPTY_COMPONENT_DRAFT: Readonly<CustomComponentDraft> = Object.freeze({
  name: '',
  title: '',
  group: '自定义',
  icon: '',
  version: '1.0.0',
  description: '',
  props: [],
  events: [],
  slots: [],
})

/** 新建属性行 */
export function createPropDraft(): PropDraft {
  return { ...EMPTY_PROP_DRAFT }
}

/** 新建事件行 */
export function createEventDraft(): EventDraft {
  return { ...EMPTY_EVENT_DRAFT }
}

/** 新建插槽行；默认插槽名先填好，多数组件只需再补区域 */
export function createSlotDraft(): SlotDraft {
  return { ...EMPTY_SLOT_DRAFT, name: 'default', title: '默认插槽' }
}

/** 外部输入（IndexedDB、默认值文本）收窄用的最小结构判断 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把任意 JSON 值收窄成 `PropValue`。
 *
 * IndexedDB 与属性文本都是外部输入，`JSON.parse` 的结果是 `unknown`；这里显式收窄，
 * 避免用断言把 `undefined`、函数之类不可能出现在 JSON 里的值带进 schema。
 */
export function toPropValue(value: unknown): PropValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.map((item) => toPropValue(item) ?? null)
  }
  if (isRecord(value)) {
    const result: Record<string, PropValue> = {}
    for (const [key, item] of Object.entries(value)) {
      const resolved = toPropValue(item)
      if (resolved !== undefined) result[key] = resolved
    }
    return result
  }
  return undefined
}

const INVALID_JSON = Symbol('invalid-json')

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return INVALID_JSON
  }
}

/**
 * 解析属性默认值文本。
 *
 * 按类型分口径：文本 / 颜色 / 枚举取原值，数字与布尔按字面解析，其余类型要求 JSON。
 * 返回值区分「未填写」与「填写但解析失败」，表单只在后者报错。
 */
export function parsePropDefault(
  type: PropType,
  text: string,
): { value?: PropValue; error?: string } {
  const raw = text.trim()
  if (raw === '') return {}

  switch (type) {
    case 'number': {
      const value = Number(raw)
      return Number.isFinite(value) ? { value } : { error: '默认值需要是数字' }
    }
    case 'boolean':
      if (raw === 'true') return { value: true }
      if (raw === 'false') return { value: false }
      return { error: '默认值需要是 true 或 false' }
    case 'string':
    case 'color':
    case 'enum':
      return { value: raw }
    default: {
      const parsed: unknown = parseJson(raw)
      if (parsed === INVALID_JSON) return { error: '默认值需要是合法 JSON' }
      const value = toPropValue(parsed)
      return value === undefined ? { error: '默认值需要是合法 JSON' } : { value }
    }
  }
}

/** 枚举选项文本 → 属性选项；留空行忽略，缺标签时标签与值同文 */
function parseOptions(text: string): PropDefinition['options'] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) return undefined

  return lines.map((line) => {
    const index = line.indexOf('=')
    if (index < 0) return { label: line, value: line }
    const value = line.slice(0, index).trim()
    const label = line.slice(index + 1).trim()
    return { label: label === '' ? value : label, value }
  })
}

/** 空串按「未填写」处理，不落库为 `''` */
function normalizeOptional(text: string): string | undefined {
  const value = text.trim()
  return value === '' ? undefined : value
}

/** 属性行 → 属性定义；属性名留空的行直接丢弃 */
export function definitionsFromDraft(props: readonly PropDraft[]): PropDefinition[] {
  const definitions: PropDefinition[] = []

  for (const draft of props) {
    const name = draft.name.trim()
    if (name === '') continue

    const parsed = parsePropDefault(draft.type, draft.defaultText)
    const options = draft.type === 'enum' ? parseOptions(draft.optionsText) : undefined
    definitions.push({
      name,
      title: draft.title.trim() || name,
      type: draft.type,
      ...(parsed.value === undefined ? {} : { defaultValue: parsed.value }),
      ...(options === undefined ? {} : { options }),
    })
  }

  return definitions
}

/** 属性定义 → 属性行；管理页不支持的类型回落成文本行，避免编辑时丢属性 */
export function draftFromDefinitions(definitions: readonly PropDefinition[]): PropDraft[] {
  return definitions.map((definition) => ({
    name: definition.name,
    title: definition.title,
    type: SELECTABLE_PROP_TYPES.find((type) => type === definition.type) ?? 'string',
    defaultText: defaultTextOf(definition.defaultValue),
    optionsText: (definition.options ?? [])
      .map((option) => `${option.value}=${option.label}`)
      .join('\n'),
  }))
}

function defaultTextOf(value: PropValue | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

/** 属性默认值汇总；同时作为物料 snippet 的初始属性与蓝图表达式里 `props` 的取值 */
export function defaultPropsFromDefinitions(
  definitions: readonly PropDefinition[],
): Record<string, PropValue> {
  const defaults: Record<string, PropValue> = {}
  for (const definition of definitions) {
    if (definition.defaultValue !== undefined)
      defaults[definition.name] = definition.defaultValue
  }
  return defaults
}

/** 事件类型缺省值；只填名称时按「无参数说明」处理 */
const DEFAULT_EVENT_PARAM_TYPE = 'unknown'

/**
 * 事件行 → 事件定义。
 *
 * 参数文本每行 `名称` 或 `名称=类型`；留空行忽略，重复名称保留先出现的那条
 * （同属性行的口径）。
 */
export function eventsFromDraft(events: readonly EventDraft[]): EventDefinition[] {
  const definitions: EventDefinition[] = []

  for (const draft of events) {
    const name = draft.name.trim()
    if (name === '') continue

    const parameters = parseEventParameters(draft.paramsText)
    const description = normalizeOptional(draft.description)
    definitions.push({
      name,
      title: draft.title.trim() || name,
      ...(parameters.length === 0 ? {} : { parameters }),
      ...(description === undefined ? {} : { description }),
    })
  }

  return definitions
}

function parseEventParameters(text: string): EventParameter[] {
  const seen = new Set<string>()
  const parameters: EventParameter[] = []

  for (const line of text.split('\n')) {
    const raw = line.trim()
    if (raw === '') continue

    const index = raw.indexOf('=')
    const name = (index < 0 ? raw : raw.slice(0, index)).trim()
    if (name === '' || seen.has(name)) continue

    seen.add(name)
    parameters.push({
      name,
      type:
        (index < 0 ? DEFAULT_EVENT_PARAM_TYPE : raw.slice(index + 1).trim()) ||
        DEFAULT_EVENT_PARAM_TYPE,
    })
  }

  return parameters
}

/** 事件定义 → 事件行 */
export function draftFromEventDefinitions(
  definitions: readonly EventDefinition[],
): EventDraft[] {
  return definitions.map((definition) => ({
    name: definition.name,
    title: definition.title,
    description: definition.description ?? '',
    paramsText: (definition.parameters ?? [])
      .map((parameter) => `${parameter.name}=${parameter.type}`)
      .join('\n'),
  }))
}

/**
 * 插槽行 → 插槽声明。
 *
 * 区域按 `SlotRegion` 的比例语义存：表单里填百分比（贴边区域在容器被拉大时仍然
 * 贴边），落库换成 0-1。四个值没填齐就整条丢弃区域，等于「覆盖整个容器」，
 * 这也是 `SlotDefinition.region` 省略时的官方语义。
 */
export function slotsFromDraft(slots: readonly SlotDraft[]): SlotDefinition[] {
  const definitions: SlotDefinition[] = []

  for (const draft of slots) {
    const name = draft.name.trim()
    if (name === '') continue

    const accepts = splitNames(draft.acceptsText)
    const max = toMaxChildren(draft.maxText)
    const region = regionFromDraft(draft)
    const description = normalizeOptional(draft.description)

    definitions.push({
      name,
      title: draft.title.trim() || name,
      ...(description === undefined ? {} : { description }),
      ...(accepts.length === 0 ? {} : { accepts }),
      ...(max === undefined ? {} : { maxChildren: max }),
      ...(region === undefined ? {} : { region }),
    })
  }

  return definitions
}

function splitNames(text: string): string[] {
  const seen = new Set<string>()
  for (const part of text.split(/[,，\s]+/)) {
    const name = part.trim()
    if (name !== '') seen.add(name)
  }
  return [...seen]
}

/** 只有正整数才算限制；留空、0 与非法值都按「不限制」 */
function toMaxChildren(text: string): number | undefined {
  const value = Number(text.trim())
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function regionFromDraft(draft: SlotDraft): SlotRegion | undefined {
  const values = [draft.x, draft.y, draft.width, draft.height]
  if (values.every((value) => value.trim() === '')) return undefined

  const [x, y, width, height] = values.map((value) => Number(value.trim()))
  if (!values.every((value) => value.trim() !== '')) return undefined
  if (!isRatio(x) || !isRatio(y) || !isRatio(width) || !isRatio(height)) return undefined
  if (width <= 0 || height <= 0) return undefined

  return { x: x / 100, y: y / 100, width: width / 100, height: height / 100 }
}

function isRatio(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100
}

/** 插槽声明 → 插槽行；区域从比例还原成百分比文本 */
export function draftFromSlotDefinitions(definitions: readonly SlotDefinition[]): SlotDraft[] {
  return definitions.map((definition) => ({
    name: definition.name,
    title: definition.title,
    description: definition.description ?? '',
    acceptsText: (definition.accepts ?? []).join(', '),
    maxText: definition.maxChildren === undefined ? '' : String(definition.maxChildren),
    x: percentText(definition.region?.x ?? 0, definition.region !== undefined),
    y: percentText(definition.region?.y ?? 0, definition.region !== undefined),
    width: percentText(definition.region?.width ?? 100, definition.region !== undefined),
    height: percentText(definition.region?.height ?? 100, definition.region !== undefined),
  }))
}

function percentText(value: number, hasRegion: boolean): string {
  return hasRegion ? String(Math.round(value * 100)) : ''
}

/**
 * 属性定义 → 物料 props（属性面板消费的 JsonSchema）。
 *
 * 字段口径对齐 `PropertiesPanel` 的 `toPropType`：颜色写 `format: 'color'`，
 * 枚举写 `enum` 数组，其余用 JSON Schema 的基础 `type`。
 */
export function jsonSchemaFromProps(props: readonly PropDefinition[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {}

  for (const definition of props) {
    const key = definition.name.trim()
    if (key === '') continue
    properties[key] = jsonFieldFromProp(definition)
  }

  return { type: 'object', properties }
}

function jsonFieldFromProp(definition: PropDefinition): JsonSchema {
  const title = definition.title.trim() || definition.name
  const field: JsonSchema = { title }
  const hasDefault = definition.defaultValue !== undefined

  switch (definition.type) {
    case 'number':
      return {
        ...field,
        type: 'number',
        ...(hasDefault ? { default: definition.defaultValue } : {}),
      }
    case 'boolean':
      return {
        ...field,
        type: 'boolean',
        ...(hasDefault ? { default: definition.defaultValue } : {}),
      }
    case 'color':
      return {
        ...field,
        type: 'string',
        format: 'color',
        ...(hasDefault ? { default: definition.defaultValue } : {}),
      }
    case 'enum':
      return {
        ...field,
        type: 'string',
        enum: (definition.options ?? []).map((option) => option.value),
        ...(hasDefault ? { default: definition.defaultValue } : {}),
      }
    case 'object':
      return { ...field, type: 'object' }
    case 'array':
      return { ...field, type: 'array' }
    default:
      return {
        ...field,
        type: 'string',
        ...(hasDefault ? { default: definition.defaultValue } : {}),
      }
  }
}

/**
 * 校验定义草稿。
 *
 * 覆盖表单能产出的破坏性输入：组件名非法或重名、必填文案为空、属性名冲突、
 * 默认值解析失败、枚举缺选项。返回全部错误而不是首个，表单一次标出所有区块。
 *
 * 节点图不校验：它由画布维护，根缺失会在保存时被 `saveCustomComponent` 拦下。
 *
 * @param draft 当前草稿
 * @param takenNames 已被占用的物料名（内置物料与其他自定义组件），不含正在编辑的这条
 */
export function validateComponentDraft(
  draft: CustomComponentDraft,
  takenNames: readonly string[],
): DraftIssue[] {
  const issues: DraftIssue[] = []
  const name = draft.name.trim()

  if (name === '') issues.push({ field: 'name', message: '组件名不能为空' })
  else if (!IDENTIFIER_PATTERN.test(name))
    issues.push({ field: 'name', message: '组件名需要以字母开头，只含字母、数字和下划线' })
  else if (takenNames.includes(name))
    issues.push({ field: 'name', message: `已有同名物料：${name}` })

  if (draft.title.trim() === '') issues.push({ field: 'title', message: '展示标题不能为空' })
  if (draft.group.trim() === '') issues.push({ field: 'group', message: '分组不能为空' })
  if (!VERSION_PATTERN.test(draft.version.trim()))
    issues.push({ field: 'version', message: '版本号需要形如 1.0.0' })

  issues.push(...validateProps(draft.props))
  issues.push(...validateEvents(draft.events))
  issues.push(...validateSlots(draft.slots))

  return issues
}

function validateSlots(slots: readonly SlotDraft[]): DraftIssue[] {
  const issues: DraftIssue[] = []
  const names = new Set<string>()

  for (const draft of slots) {
    const name = draft.name.trim()
    if (name === '') {
      issues.push({ field: 'slots', message: '插槽名不能为空' })
      continue
    }

    // 插槽名会直接当 `node.slots` 的键使用，也必须是可以写进表达式的标识符
    if (!IDENTIFIER_PATTERN.test(name)) {
      issues.push({ field: 'slots', message: `插槽名 ${name} 不是合法标识符` })
    } else if (names.has(name)) {
      issues.push({ field: 'slots', message: `插槽名重复：${name}` })
    } else {
      names.add(name)
    }

    if (draft.title.trim() === '') {
      issues.push({ field: 'slots', message: `插槽 ${name} 需要填写显示标题` })
    }

    const filled = [draft.x, draft.y, draft.width, draft.height].filter(
      (v) => v.trim() !== '',
    ).length
    if (filled !== 0 && filled !== 4) {
      issues.push({ field: 'slots', message: `插槽 ${name} 的区域需要 X、Y、宽、高四项一起填` })
    } else if (filled === 4 && regionFromDraft(draft) === undefined) {
      issues.push({
        field: 'slots',
        message: `插槽 ${name} 的区域取值要在 0-100 之间，且宽高要大于 0`,
      })
    }
  }

  return issues
}

function validateEvents(events: readonly EventDraft[]): DraftIssue[] {
  const issues: DraftIssue[] = []
  const names = new Set<string>()

  for (const draft of events) {
    const name = draft.name.trim()
    if (name === '') {
      issues.push({ field: 'events', message: '事件名不能为空' })
      continue
    }

    // 事件名不做标识符限制：平台既有约定里事件名是自由字符串（如 'click'、'onConfirm'），
    // 接线时按字面匹配，收紧成标识符只会挡住已经在用的写法
    if (names.has(name)) {
      issues.push({ field: 'events', message: `事件名重复：${name}` })
    } else {
      names.add(name)
    }

    if (draft.title.trim() === '') {
      issues.push({ field: 'events', message: `事件 ${name} 需要填写显示标题` })
    }
  }

  return issues
}

function validateProps(props: readonly PropDraft[]): DraftIssue[] {
  const issues: DraftIssue[] = []
  const names = new Set<string>()

  for (const draft of props) {
    const name = draft.name.trim()
    if (name === '') {
      issues.push({ field: 'props', message: '属性名不能为空' })
      continue
    }

    if (!IDENTIFIER_PATTERN.test(name)) {
      issues.push({ field: 'props', message: `属性名 ${name} 不是合法标识符` })
    } else if (names.has(name)) {
      issues.push({ field: 'props', message: `属性名重复：${name}` })
    } else {
      names.add(name)
    }

    const parsed = parsePropDefault(draft.type, draft.defaultText)
    if (parsed.error) {
      issues.push({ field: 'props', message: `${name} ${parsed.error}` })
    }
    if (draft.type === 'enum' && parseOptions(draft.optionsText) === undefined) {
      issues.push({ field: 'props', message: `枚举属性 ${name} 需要至少一个选项` })
    }
  }

  return issues
}

/**
 * 草稿元信息 → 定义字段。
 *
 * 统一在这里裁空白、补默认分组与版本，并把空串收敛成「未填写」，
 * 这样存储里不会留下 `icon: ''` 这类既无意义又干扰 diff 的字段。
 */
export function metaFromDraft(draft: CustomComponentDraft): {
  name: string
  title: string
  group: string
  version: string
  icon?: string
  description?: string
} {
  const name = draft.name.trim()
  const icon = normalizeOptional(draft.icon)
  const description = normalizeOptional(draft.description)

  return {
    name,
    title: draft.title.trim() || name,
    group: draft.group.trim() || '自定义',
    version: draft.version.trim() || '1.0.0',
    ...(icon === undefined ? {} : { icon }),
    ...(description === undefined ? {} : { description }),
  }
}

/** 组件定义 → 编辑草稿；节点图不参与，画布自己从定义里取 */
export function draftFromDefinition(
  definition: ComponentSchema,
  id?: string,
): CustomComponentDraft {
  const { meta } = definition
  return {
    id,
    name: meta.name,
    title: meta.title,
    group: meta.group,
    icon: meta.icon ?? '',
    version: meta.version,
    description: meta.description ?? '',
    props: draftFromDefinitions(definition.props ?? []),
    events: draftFromEventDefinitions(definition.events ?? []),
    slots: draftFromSlotDefinitions(definition.slots ?? []),
  }
}
