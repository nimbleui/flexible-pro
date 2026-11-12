import type {
  ComponentSchema,
  EventDefinition,
  NodeSchema,
  PageSchema,
  PropDefinition,
  PropValue,
  Rect,
  SlotDefinition,
} from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'

/**
 * 蓝图文档与组件定义的互转。
 *
 * 画布只认 `PageSchema`：文档服务、历史、选中集、拖入与变换命令全部按
 * `nodeId` + `nodes` 工作，而 `ComponentSchema` 的节点图恰好是同构的这两件事。
 * 于是蓝图编辑复用整条画布链路，代价只是「文档的页面级字段（变量、数据源、
 * 事件流、生命周期）不属于组件定义」，这些编辑入口在蓝图视图里因此不开放。
 */

/** 蓝图文档 id 前缀；与页面文档分属不同命名空间，避免与 documentId 相撞 */
const BLUEPRINT_DOCUMENT_PREFIX = 'component-blueprint:'

/** 新建蓝图的根节点 id；`canvas-drop` 未命中容器时回落到它，保证任何落点都能插入 */
const BLUEPRINT_ROOT_ID = 'root'

/**
 * 定义表产出的组件字段。
 *
 * 用一个对象而不是四个并列位置参数：这四块总是整套出现，调用方漏传其一
 * 会得到一份缺声明的定义，而对象写法让缺项在类型上就说不通。
 */
export interface ComponentFields {
  /** 组件元信息 */
  meta: ComponentSchema['meta']
  /** 对外属性 */
  props: readonly PropDefinition[]
  /** 对外事件 */
  events: readonly EventDefinition[]
  /** 插槽声明 */
  slots: readonly SlotDefinition[]
}

/** 新建蓝图的根容器尺寸：够放一层内容，又不会在画布上占满整屏 */
const BLUEPRINT_ROOT_SIZE: Readonly<Rect> = { x: 0, y: 0, width: 360, height: 240 }

/** 蓝图里读不到任何几何信息时给 snippet 的兜底尺寸 */
const FALLBACK_SIZE: Readonly<{ width: number; height: number }> = { width: 320, height: 200 }

/**
 * 蓝图文档 id。
 *
 * 与页面文档分属不同命名空间：蓝图 Realm 的生命周期跟着编辑视图，页面 Realm 跟着工作区，
 * 两者共用 `documentId` 索引，撞上就会互相复用错误的文档。
 */
export function blueprintDocumentId(componentId: string): string {
  return `${BLUEPRINT_DOCUMENT_PREFIX}${componentId}`
}

/** 起始节点图：一个可容纳子节点的根容器 */
export function createBlueprintNodes(): Record<string, NodeSchema> {
  return {
    [BLUEPRINT_ROOT_ID]: {
      id: BLUEPRINT_ROOT_ID,
      componentName: 'Box',
      layout: { mode: 'absolute', rect: { ...BLUEPRINT_ROOT_SIZE } },
    },
  }
}

/**
 * 组件定义 → 画布文档。
 *
 * 节点整体深拷贝：文档服务把 `model.schema` 当只读快照对外给出，但写入走 patch，
 * 拷贝一份可以确保「Realm 里的节点」和「store 里的定义」不是同一个对象，
 * 取消编辑时不会把画布上的中间态漏回定义。
 *
 * 根 id 读不到节点时按第一个节点兜底，全空才建新根：手改过的 IndexedDB
 * 不该让编辑页直接白屏。
 */
export function blueprintSchemaOf(
  definition: ComponentSchema | undefined,
  title: string,
): PageSchema {
  const source = definition ? clone(definition.nodes) : {}
  const declared = definition?.nodeId ?? ''
  const rawRootId = source[declared] ? declared : (Object.keys(source)[0] ?? '')

  if (rawRootId === '') {
    return {
      version: SCHEMA_VERSION,
      // 一个节点都没有时回到起始蓝图：画布的命中与包围盒都需要一个根
      nodeId: BLUEPRINT_ROOT_ID,
      nodes: createBlueprintNodes(),
      components: [],
      metadata: { title },
    }
  }

  const ids = renameMap(Object.values(source))

  return {
    version: SCHEMA_VERSION,
    // 根 id 走同一张重命名表：与节点 id 各自推导会指向两个不同的根
    nodeId: ids.get(rawRootId) ?? rawRootId,
    nodes: renameNodes(source, ids),
    components: [],
    metadata: { title },
  }
}

/**
 * 蓝图节点 id 的命名空间前缀。
 *
 * 画布给新节点用的是进程内递增 id（`createId` 明确不保证跨刷新唯一），刷新后计数
 * 从 1 重新开始。持久化的蓝图里已经存在 `node-1`，原样载入的话再拖一个物料进来就会
 * 把同 id 的旧节点整个覆盖，并把重复 id 写进父节点的 children。
 * 前缀只加一次：保存后的 id 天生带命名空间，重复进出编辑页不会越加越长。
 */
const ID_PREFIX = 'bp-'

function preferredId(id: string): string {
  return id.startsWith(ID_PREFIX) ? id : `${ID_PREFIX}${id}`
}

/**
 * 旧 id → 新 id。
 *
 * 前缀本身不保证唯一：同一份蓝图里可能同时有 `bp-node-1`（上次已加过前缀）和
 * `node-1`（刷新后重新计数拖入的新节点），两者的前缀候选相同。直接写入会静默
 * 少一个节点，所以第二个及之后的同名候选按 `-2`、`-3` 顺延，并跳过别人的候选
 * 与已经发出去的 id。
 */
function renameMap(nodes: readonly NodeSchema[]): Map<string, string> {
  const wanted = new Set(nodes.map((node) => preferredId(node.id)))
  const result = new Map<string, string>()
  const taken = new Set<string>()

  for (const node of nodes) {
    const base = preferredId(node.id)
    let id = base
    let suffix = 2
    while (taken.has(id) || (id !== base && wanted.has(id))) id = `${base}-${suffix++}`
    taken.add(id)
    result.set(node.id, id)
  }

  return result
}

/**
 * 改 id 的同时改父引用：`children` 与 `slots` 里存的都必须是同一个新 id。
 *
 * 引用指向表里没有的 id 时保持原样：那是本来就失效的悬空引用，改名救不回来，
 * 硬加前缀只会让它更难在诊断面板里对上号。
 */
function renameNodes(
  nodes: Record<string, NodeSchema>,
  ids: ReadonlyMap<string, string>,
): Record<string, NodeSchema> {
  const idOf = (id: string): string => ids.get(id) ?? id
  const result: Record<string, NodeSchema> = {}

  for (const node of Object.values(nodes)) {
    const renamed: NodeSchema = {
      ...node,
      id: idOf(node.id),
      ...(node.children === undefined ? {} : { children: node.children.map(idOf) }),
      ...(node.slots === undefined
        ? {}
        : {
            slots: Object.fromEntries(
              Object.entries(node.slots).map(([name, refs]) => [name, refs.map(idOf)]),
            ),
          }),
    }
    result[renamed.id] = renamed
  }

  return result
}

/**
 * 画布文档 + 定义表 → 组件定义。
 *
 * 节点图以文档为准原样回写（含画布写入的 style / hidden / locked / 旋转 / 层级），
 * 定义表字段以表单为准：两侧各有唯一写入方，不做字段级合并。
 */
export function definitionFromBlueprint(
  schema: PageSchema,
  fields: ComponentFields,
): ComponentSchema {
  const { meta, props, events, slots } = fields
  const nodes = clone(schema.nodes)
  const defaults = defaultPropsOf(props)

  return {
    meta,
    nodeId: schema.nodeId,
    nodes,
    ...(props.length === 0 ? {} : { props: [...props] }),
    ...(events.length === 0 ? {} : { events: [...events] }),
    ...(slots.length === 0 ? {} : { slots: [...slots] }),
    ...(Object.keys(defaults).length === 0 ? {} : { defaultProps: defaults }),
  }
}

/**
 * 新建组件的首版定义。
 *
 * 创建弹框只收定义表（元信息、属性、事件、插槽），蓝图此刻还是起始容器；
 * 用户确认后立即拿到 id 并进画布补结构，所以这里必须给出一个合法根节点，
 * 否则 `saveCustomComponent` 会以「缺少根节点」拒绝写入。
 */
export function initialComponentSchema(fields: ComponentFields): ComponentSchema {
  return definitionFromBlueprint(
    {
      version: SCHEMA_VERSION,
      nodeId: BLUEPRINT_ROOT_ID,
      nodes: createBlueprintNodes(),
      components: [],
      metadata: { title: fields.meta.title },
    },
    fields,
  )
}

function defaultPropsOf(props: readonly PropDefinition[]): Record<string, PropValue> {
  const defaults: Record<string, PropValue> = {}
  for (const definition of props) {
    if (definition.defaultValue !== undefined)
      defaults[definition.name] = definition.defaultValue
  }
  return defaults
}

/**
 * 蓝图内容包围盒；决定物料 snippet 的默认宽高，让「拖出来的尺寸」等于「设计时的尺寸」。
 *
 * 只统计有绝对定位矩形的节点：`flow` 布局节点尚无矩形，计入会把包围盒压成 0。
 */
export function contentBounds(nodes: Readonly<Record<string, NodeSchema>>): Rect {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const node of Object.values(nodes)) {
    const rect = node.layout?.rect
    if (!rect) continue
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }

  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, width: FALLBACK_SIZE.width, height: FALLBACK_SIZE.height }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** JSON 往返拷贝：节点内容本来就要求可 JSON 序列化（同 `IndexedDB` 与画布拖入） */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
