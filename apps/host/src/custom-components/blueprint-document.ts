import type {
  ComponentSchema,
  EventDefinition,
  NodeSchema,
  PageSchema,
  PropDefinition,
  PropValue,
  Rect,
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
 * 根 id 读不到节点时按第一个节点兜底，全空才建新根：手改过的 localStorage
 * 不该让编辑页直接白屏。
 */
export function blueprintSchemaOf(
  definition: ComponentSchema | undefined,
  title: string,
): PageSchema {
  const source = definition ? clone(definition.nodes) : {}
  const declared = definition?.nodeId ?? ''
  const rawRootId = source[declared] ? declared : (Object.keys(source)[0] ?? '')
  const hasRoot = rawRootId !== ''

  return {
    version: SCHEMA_VERSION,
    // 根 id 失效或一个节点都没有时回到起始蓝图：画布的命中与包围盒都需要一个根
    nodeId: hasRoot ? namespaceId(rawRootId) : BLUEPRINT_ROOT_ID,
    nodes: hasRoot ? namespaceNodes(source) : createBlueprintNodes(),
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

function namespaceId(id: string): string {
  return id.startsWith(ID_PREFIX) ? id : `${ID_PREFIX}${id}`
}

/** 改 id 的同时改父引用：`children` 与 `slots` 里存的都必须是同一个新 id */
function namespaceNodes(nodes: Record<string, NodeSchema>): Record<string, NodeSchema> {
  const result: Record<string, NodeSchema> = {}

  for (const node of Object.values(nodes)) {
    const renamed: NodeSchema = {
      ...node,
      id: namespaceId(node.id),
      ...(node.children === undefined ? {} : { children: node.children.map(namespaceId) }),
      ...(node.slots === undefined
        ? {}
        : {
            slots: Object.fromEntries(
              Object.entries(node.slots).map(([name, ids]) => [name, ids.map(namespaceId)]),
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
 * 元信息与对外属性以定义表为准：两块各有唯一写入方，不做字段级合并。
 */
export function definitionFromBlueprint(
  schema: PageSchema,
  meta: ComponentSchema['meta'],
  props: readonly PropDefinition[],
  events: readonly EventDefinition[] = [],
): ComponentSchema {
  const nodes = clone(schema.nodes)
  const defaults = defaultPropsOf(props)

  return {
    meta,
    nodeId: schema.nodeId,
    nodes,
    ...(props.length === 0 ? {} : { props: [...props] }),
    ...(events.length === 0 ? {} : { events: [...events] }),
    ...(Object.keys(defaults).length === 0 ? {} : { defaultProps: defaults }),
  }
}

/**
 * 新建组件的首版定义。
 *
 * 创建弹框只收定义表（元信息、属性、事件），蓝图此刻还是空的起始容器；
 * 用户确认后立即拿到 id 并进画布补结构，所以这里必须给出一个合法根节点，
 * 否则 `saveCustomComponent` 会以「缺少根节点」拒绝写入。
 */
export function initialComponentSchema(
  meta: ComponentSchema['meta'],
  props: readonly PropDefinition[],
  events: readonly EventDefinition[],
): ComponentSchema {
  return definitionFromBlueprint(
    {
      version: SCHEMA_VERSION,
      nodeId: BLUEPRINT_ROOT_ID,
      nodes: createBlueprintNodes(),
      components: [],
      metadata: { title: meta.title },
    },
    meta,
    props,
    events,
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

/** JSON 往返拷贝：节点内容本来就要求可 JSON 序列化（同 `localStorage` 与画布拖入） */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
