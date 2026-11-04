import { shallowRef } from 'vue'
import type { Disposable } from '@lc/kernel'
import type { MaterialEntry, MaterialService, ModuleService } from '@lc/contracts'
import { moduleKey } from '@lc/contracts'
import type {
  ComponentSchema,
  EventDefinition,
  LayoutConstraints,
  LayoutSchema,
  NodeSchema,
  PropDefinition,
  PropValue,
  Rect,
  SlotDefinition,
  SlotRegion,
  StyleSchema,
} from '@lc/schema'
import { HORIZONTAL_CONSTRAINTS, VERTICAL_CONSTRAINTS } from '@lc/vue'
import {
  jsonSchemaFromProps,
  isRecord,
  SELECTABLE_PROP_TYPES,
  toPropValue,
} from './component-draft'
import { contentBounds } from './blueprint-document'
import { createCompositeComponent } from './composite-component'

/**
 * 全局自定义组件。
 *
 * 与页面里的临时组合节点不同，这里的每条定义都是一个复合组件：蓝图（节点图）+ 属性表，
 * 由本模块注册成物料后进画布物料面板，任何页面都能拖用。目前没有后端，存储落在
 * localStorage；接服务端时只需替换本文件的读写实现，与全局函数同构。
 *
 * 蓝图节点由画布写入，读档时保留画布会改到的字段：物料名、父子引用、属性、布局
 * （矩形 / 旋转 / 层级 / 流式）、样式区的四个可编辑属性、图层显隐与锁定。
 * `loop`、`directives`、`condition` 这类节点能力当前不属于组件蓝图，
 * 读档不保留，以免出现「界面上看不见、却被保存并渲染」的幽灵配置。
 */

/**
 * 物料与模块登记用的插件名；自定义组件不属于任何插件包，用平台自己的名字占位。
 *
 * 页面据此区分「自己登记的条目」与「构建期贡献」：同名时贡献始终胜出，
 * 撞名需要提示用户，而不是让他以为组件没生效。
 */
export const CUSTOM_PLUGIN = 'custom-components'

/** 自定义组件的优先级；同名时贡献始终压过运行时注册，这里只用于停用/启用之间的排序稳定性 */
const CUSTOM_PRIORITY = 20

const STORAGE_KEY = 'lc.custom-components.v1'
const listeners = new Set<() => void>()

/** 一条自定义组件定义 */
export interface CustomComponent {
  /** 稳定 id，供编辑路由使用；改名不影响它 */
  id: string
  /** 组件定义本体，与 `PageSchema.components` 共用同一份 schema 结构 */
  definition: ComponentSchema
  /** 是否注册进画布物料面板；关闭后定义保留但不再出现在拖拽列表里 */
  enabled: boolean
  /** 最后修改时间（ISO 字符串） */
  updatedAt: string
}

/** 新建或更新自定义组件的输入；id 缺省表示新建 */
export interface CustomComponentInput {
  /** 目标条目 id；传入不存在的 id 直接抛错而不是静默新建 */
  id?: string
  /** 组件定义；`meta.name` 全局唯一 */
  definition: ComponentSchema
  /** 缺省沿用已有条目的值，新建时为 true */
  enabled?: boolean
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 几何值必须四个都是有限数，否则布局会被写成 NaN 并让整棵子树消失 */
function readRect(value: unknown): Rect | undefined {
  if (!isRecord(value)) return undefined
  const { x, y, width, height } = value
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return undefined
  }
  if (!Number.isFinite(x + y + width + height)) return undefined
  return { x, y, width, height }
}

/** 属性映射表：值经 `toPropValue` 收窄，表达式对象 `{ type: 'expression', raw }` 原样保留 */
function readPropMap(value: unknown): Record<string, PropValue> | undefined {
  if (!isRecord(value)) return undefined

  const props: Record<string, PropValue> = {}
  for (const [key, item] of Object.entries(value)) {
    const resolved = toPropValue(item)
    if (resolved !== undefined) props[key] = resolved
  }
  return Object.keys(props).length === 0 ? undefined : props
}

/**
 * 收窄单个节点。
 *
 * id 与物料名缺一不可；`children` 必须逐项是字符串，否则渲染层会拿着非 id 的引用
 * 在画布上留下一个既不可见也选不中的空洞。
 */
function readNode(value: unknown): NodeSchema | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.componentName !== 'string' || value.componentName === '') return undefined

  const nodeName = typeof value.name === 'string' && value.name !== '' ? value.name : undefined
  const layout = readLayout(value.layout)
  const style = readStyle(value.style)
  const props = readPropMap(value.props)

  return {
    id: value.id,
    componentName: value.componentName,
    ...(nodeName === undefined ? {} : { name: nodeName }),
    ...(isStringArray(value.children) ? { children: value.children } : {}),
    ...(props === undefined ? {} : { props }),
    ...(layout === undefined ? {} : { layout }),
    ...(style === undefined ? {} : { style }),
    ...(value.hidden === true ? { hidden: true } : {}),
    ...(value.locked === true ? { locked: true } : {}),
  }
}

/**
 * 收窄节点布局：矩形、旋转、层级与放置模式。
 *
 * 后三项由画布的旋转 / 图层命令写入，缺掉任何一个都会让「画布上摆好的位置」
 * 在刷新后回到原点。全部字段缺失时返回 undefined，不写出一个空 layout。
 */
function readLayout(value: unknown): LayoutSchema | undefined {
  if (!isRecord(value)) return undefined

  const rect = readRect(value.rect)
  const rotate = readFinite(value.rotate)
  const zIndex = readFinite(value.zIndex)
  const mode = value.mode === 'flow' || value.mode === 'absolute' ? value.mode : undefined
  const constraints = readConstraints(value.constraints)
  if (
    rect === undefined &&
    rotate === undefined &&
    zIndex === undefined &&
    mode === undefined &&
    constraints === undefined
  ) {
    return undefined
  }

  return {
    ...(mode === undefined ? {} : { mode }),
    ...(rect === undefined ? {} : { rect }),
    ...(rotate === undefined ? {} : { rotate }),
    ...(zIndex === undefined ? {} : { zIndex }),
    ...(constraints === undefined ? {} : { constraints }),
  }
}

/**
 * 收窄锁位约束。
 *
 * 只认渲染层会读的五个取值：属性面板的下拉本身也只给这几个值，出现别的字符串说明
 * 数据被手改过，丢掉比"按未知约束渲染"更可预期。
 */
function readConstraints(value: unknown): LayoutConstraints | undefined {
  if (!isRecord(value)) return undefined

  const horizontal = HORIZONTAL_CONSTRAINTS.find((item) => item === value.horizontal)
  const vertical = VERTICAL_CONSTRAINTS.find((item) => item === value.vertical)
  if (horizontal === undefined && vertical === undefined) return undefined

  return {
    ...(horizontal === undefined ? {} : { horizontal }),
    ...(vertical === undefined ? {} : { vertical }),
  }
}

/**
 * 收窄节点样式。
 *
 * 只保留属性面板「样式」区能写入的四个字段：`StyleSchema` 带
 * `[key: string]: unknown` 索引签名，整体透传会让 localStorage 里手写的任意 CSS
 * 悄悄生效；按字段收窄才能保证「存进去的」与「界面上改得到的」是同一批属性。
 */
function readStyle(value: unknown): StyleSchema | undefined {
  if (!isRecord(value)) return undefined

  const style: StyleSchema = {}
  if (typeof value.padding === 'string') style.padding = value.padding
  if (typeof value.borderRadius === 'string') style.borderRadius = value.borderRadius
  if (typeof value.backgroundColor === 'string') style.backgroundColor = value.backgroundColor

  const opacity = readFinite(value.opacity)
  if (opacity !== undefined) style.opacity = opacity

  return Object.keys(style).length === 0 ? undefined : style
}

function readFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readOptionValue(value: unknown): string | number | boolean {
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return typeof value === 'string' ? value : ''
}

/**
 * 收窄属性定义。
 *
 * 类型按管理页可选的类型清单校验：清单外的取值（`event` / `slot` 之类）退化成
 * `string`，比断言成 `PropType` 诚实——管理页本来也编辑不了那些类型。
 */
function readPropDefinition(value: unknown): PropDefinition | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') return undefined

  const matchedType = SELECTABLE_PROP_TYPES.find((type) => type === value.type)
  const title = typeof value.title === 'string' && value.title !== '' ? value.title : value.name
  const defaultValue = toPropValue(value.defaultValue)
  const options = Array.isArray(value.options)
    ? value.options.filter(isRecord).map((option) => {
        const optionValue = readOptionValue(option.value)
        return {
          label: typeof option.label === 'string' ? option.label : String(optionValue),
          value: optionValue,
        }
      })
    : undefined

  return {
    name: value.name,
    title,
    type: matchedType ?? 'string',
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(options === undefined ? {} : { options }),
  }
}

/** 收窄对外事件声明；参数列表允许缺省 */
function readEventDefinition(value: unknown): EventDefinition | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') return undefined

  const parameters = Array.isArray(value.parameters)
    ? value.parameters
        .filter(isRecord)
        .map((item) => ({
          name: typeof item.name === 'string' ? item.name : '',
          type: typeof item.type === 'string' ? item.type : 'unknown',
        }))
        .filter((item) => item.name !== '')
    : undefined
  const description = typeof value.description === 'string' ? value.description : ''

  return {
    name: value.name,
    title: typeof value.title === 'string' && value.title !== '' ? value.title : value.name,
    ...(parameters === undefined || parameters.length === 0 ? {} : { parameters }),
    ...(description === '' ? {} : { description }),
  }
}

/**
 * 收窄插槽声明。
 *
 * 区域四个值必须成套：`canvas-drop` 按比例命中分格，缺一角就会算出谁都没要的格子，
 * 因此宁可整条丢掉区域、退成「覆盖全屏」，也不留一份半截的 region。
 */
function readSlotDefinition(value: unknown): SlotDefinition | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') return undefined

  const title = typeof value.title === 'string' && value.title !== '' ? value.title : value.name
  const description =
    typeof value.description === 'string' && value.description !== ''
      ? value.description
      : undefined
  const accepts =
    isStringArray(value.accepts) && value.accepts.length > 0 ? value.accepts : undefined
  const maxChildren =
    typeof value.maxChildren === 'number' &&
    Number.isInteger(value.maxChildren) &&
    value.maxChildren > 0
      ? value.maxChildren
      : undefined
  const region = readRegion(value.region)

  return {
    name: value.name,
    title,
    ...(description === undefined ? {} : { description }),
    ...(accepts === undefined ? {} : { accepts }),
    ...(maxChildren === undefined ? {} : { maxChildren }),
    ...(region === undefined ? {} : { region }),
  }
}

function readRegion(value: unknown): SlotRegion | undefined {
  if (!isRecord(value)) return undefined

  const ratio = (item: unknown): number | undefined =>
    typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1
      ? item
      : undefined
  const x = ratio(value.x)
  const y = ratio(value.y)
  const width = ratio(value.width)
  const height = ratio(value.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined
  }
  if (width <= 0 || height <= 0) return undefined

  return { x, y, width, height }
}

/** 收窄组件定义；meta 与节点表是最低要求，缺一即整条丢弃 */
function readDefinition(value: unknown): ComponentSchema | undefined {
  if (!isRecord(value) || !isRecord(value.meta)) return undefined

  const { name, title, group, version, icon, description } = value.meta
  if (typeof name !== 'string' || name === '') return undefined
  if (typeof version !== 'string') return undefined
  if (typeof value.nodeId !== 'string') return undefined
  if (!isRecord(value.nodes)) return undefined

  const nodes: Record<string, NodeSchema> = {}
  for (const item of Object.values(value.nodes)) {
    const node = readNode(item)
    if (node) nodes[node.id] = node
  }

  const props = Array.isArray(value.props)
    ? value.props
        .filter(isRecord)
        .map(readPropDefinition)
        .filter((item): item is PropDefinition => item !== undefined)
    : []
  const events = Array.isArray(value.events)
    ? value.events
        .filter(isRecord)
        .map(readEventDefinition)
        .filter((item): item is EventDefinition => item !== undefined)
    : []
  const defaultProps = readPropMap(value.defaultProps)
  const slots = Array.isArray(value.slots)
    ? value.slots
        .filter(isRecord)
        .map(readSlotDefinition)
        .filter((item): item is SlotDefinition => item !== undefined)
    : []

  return {
    meta: {
      name,
      title: typeof title === 'string' && title !== '' ? title : name,
      group: typeof group === 'string' && group !== '' ? group : '自定义',
      version,
      ...(typeof icon === 'string' && icon !== '' ? { icon } : {}),
      ...(typeof description === 'string' && description !== '' ? { description } : {}),
    },
    nodeId: value.nodeId,
    nodes,
    ...(props.length === 0 ? {} : { props }),
    ...(events.length === 0 ? {} : { events }),
    ...(slots.length === 0 ? {} : { slots }),
    ...(defaultProps === undefined ? {} : { defaultProps }),
  }
}

/** 存储内容来自用户可编辑的 localStorage，读入时必须逐字段收窄 */
function readCustomComponent(value: unknown): CustomComponent | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.updatedAt !== 'string') return undefined

  const definition = readDefinition(value.definition)
  if (!definition) return undefined

  return {
    id: value.id,
    definition,
    enabled: value.enabled !== false,
    updatedAt: value.updatedAt,
  }
}

function readStorage(): CustomComponent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    // id 参与路由，组件名参与物料注册，重复条目会让两者指向错误的一行
    const ids = new Set<string>()
    const names = new Set<string>()
    const entries: CustomComponent[] = []
    for (const item of parsed) {
      const component = readCustomComponent(item)
      if (!component) continue

      const name = component.definition.meta.name
      if (ids.has(component.id) || names.has(name)) continue
      ids.add(component.id)
      names.add(name)
      entries.push(component)
    }
    return entries
  } catch (error) {
    console.error('[host] 读取自定义组件失败，按空列表处理', error)
    return []
  }
}

function persist(entries: readonly CustomComponent[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch (error) {
    // 隐私模式或配额不足时只丢持久化，当前会话里的组件仍然可用
    console.error('[host] 保存自定义组件到 localStorage 失败', error)
  }
}

const state = shallowRef<readonly CustomComponent[]>(readStorage())

/** 自定义组件列表；只读约定由调用方遵守，修改必须走 save / remove / setEnabled */
export const customComponents = state

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function commit(next: readonly CustomComponent[]): void {
  state.value = next
  persist(next)
  notify()
}

/** 生成稳定 id；只要求跨刷新唯一，不参与物料解析 */
function createComponentId(): string {
  return `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 新建或更新一条自定义组件。
 *
 * @throws 组件名为空、与其他自定义组件重名、传入的 id 不存在、
 * 或根节点 id 在蓝图里找不到时抛错
 */
export function saveCustomComponent(input: CustomComponentInput): CustomComponent {
  const name = input.definition.meta.name.trim()
  if (name === '') throw new Error('[host] 自定义组件必须有组件名')

  if (input.definition.nodeId === '' || !input.definition.nodes[input.definition.nodeId]) {
    throw new Error(`[host] 自定义组件 "${name}" 缺少根节点`)
  }

  const existing = input.id ? state.value.find((entry) => entry.id === input.id) : undefined
  if (input.id && !existing) {
    throw new Error(`[host] 待更新的自定义组件不存在: ${input.id}`)
  }

  const duplicated = state.value.some(
    (entry) => entry.definition.meta.name === name && entry.id !== existing?.id,
  )
  if (duplicated) throw new Error(`[host] 自定义组件名重复: ${name}`)

  const entry: CustomComponent = {
    id: existing?.id ?? createComponentId(),
    definition: { ...input.definition, meta: { ...input.definition.meta, name } },
    enabled: input.enabled ?? existing?.enabled ?? true,
    updatedAt: new Date().toISOString(),
  }

  const next = existing
    ? state.value.map((item) => (item.id === entry.id ? entry : item))
    : [...state.value, entry]
  commit(next)
  return entry
}

/** 删除一条自定义组件；id 不存在时不做任何事 */
export function removeCustomComponent(id: string): void {
  const next = state.value.filter((entry) => entry.id !== id)
  if (next.length === state.value.length) return
  commit(next)
}

/** 启用或停用一条自定义组件；停用即摘掉物料，新实例拖不出来，画布上的旧实例会退化成占位框 */
export function setCustomComponentEnabled(id: string, enabled: boolean): void {
  const target = state.value.find((entry) => entry.id === id)
  if (!target || target.enabled === enabled) return

  commit(state.value.map((entry) => (entry.id === id ? { ...entry, enabled } : entry)))
}

/** 订阅自定义组件变更；返回注销句柄 */
export function onCustomComponentsChange(listener: () => void): Disposable {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}

/**
 * 定义 → 物料条目。
 *
 * `snippet` 的宽高取蓝图内容包围盒：拖入画布的默认尺寸与设计时看到的尺寸一致，
 * 而不是所有自定义组件都从同一个方块开始。
 */
function materialEntryOf(component: CustomComponent): MaterialEntry {
  const { definition } = component
  const name = definition.meta.name
  const bounds = contentBounds(definition.nodes)
  const slots = definition.slots ?? []

  return {
    name,
    title: definition.meta.title,
    category: definition.meta.group,
    ...(definition.meta.icon === undefined ? {} : { icon: definition.meta.icon }),
    props: jsonSchemaFromProps(definition.props ?? []),
    // 事件声明随物料登记：事件流面板按 `entry.events` 列事件名候选
    ...(definition.events === undefined ? {} : { events: definition.events }),
    module: name,
    plugin: CUSTOM_PLUGIN,
    moduleKey: moduleKey(CUSTOM_PLUGIN, name),
    // 只有声明了插槽才把组件标成容器：命中测试认 `container` 才会往里投递，
    // 没有分格声明时让内容落进 `children` 会漂在蓝图之外，反而更像故障。
    container: slots.length > 0,
    ...(slots.length === 0 ? {} : { slots }),
    priority: CUSTOM_PRIORITY,
    snippet: {
      id: `${name}-snippet`,
      componentName: name,
      props: definition.defaultProps ?? {},
      layout: {
        mode: 'absolute',
        rect: { x: 0, y: 0, width: bounds.width, height: bounds.height },
      },
    },
  }
}

/**
 * 把自定义组件接到物料服务上，并在列表变化时整体重新注册。
 *
 * 先注销旧的再登记新的：物料与模块注册表都对同名 / 同 key 的重复登记抛错，而编辑一条
 * 组件往往只改蓝图不换代号，逐条算差集要同时维护两张注册表的状态。整体重登记在几十条
 * 的量级里更便宜，也不会出现「模块已更新、物料还指向旧实现」的中间态。
 *
 * 停用条目直接跳过登记：画布按物料名解析，摘掉物料就不再能拖出新实例；
 * 文档里已有的同名实例会解析不到组件，由舞台渲染成占位框，定义本身仍在列表里可查。
 *
 * @param material 应用级物料注册表
 * @param modules 应用级模块加载器
 * @returns 解除注册的句柄；应用销毁时由调用方释放
 */
export function installCustomComponents(
  material: MaterialService,
  modules: ModuleService,
): Disposable {
  let registrations: Disposable[] = []

  function sync(): void {
    for (const registration of registrations) registration.dispose()
    registrations = []

    for (const component of state.value) {
      if (!component.enabled) continue

      const entry = materialEntryOf(component)
      const implementation = createCompositeComponent(component.definition)
      registrations.push(
        modules.register({
          key: entry.moduleKey,
          load: () => Promise.resolve({ components: { [entry.name]: implementation } }),
        }),
        material.register(entry),
      )
    }
  }

  sync()

  const off = onCustomComponentsChange(sync)
  return {
    dispose: () => {
      off.dispose()
      for (const registration of registrations) registration.dispose()
      registrations = []
    },
  }
}

/**
 * 判断某条已启用的自定义组件当前是否真的被画布使用。
 *
 * 物料服务里同名贡献的优先级始终高于运行时注册，名字撞上内置物料时画布用的不是这份定义。
 * 列表页据此给出可见提示，而不是让人对着「拖出来不是我的组件」猜原因。
 *
 * @param component 待检查的组件；调用方只在启用状态下检查
 * @param entries 当前物料条目清单，来自物料服务的响应式列表
 * @returns 生效返回 true；被同名贡献覆盖或尚未登记时返回 false
 */
export function isCustomComponentActive(
  component: CustomComponent,
  entries: readonly MaterialEntry[],
): boolean {
  const name = component.definition.meta.name
  return entries.find((entry) => entry.name === name)?.plugin === CUSTOM_PLUGIN
}

/** 组件预览用的作用域；`SchemaPreview` 里的蓝图表达式按 `props.<属性名>` 取值 */
export function previewScopeOf(component: CustomComponent): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(component.definition.defaultProps ?? {})) {
    props[key] = value
  }
  return { props }
}
