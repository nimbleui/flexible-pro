import type {
  CanvasDropPayload,
  CanvasTransaction,
  MaterialEntry,
  Point,
  SchemaPatch,
} from '@lc/contracts'
import { defineCanvasPlugin } from '@lc/contracts'
import type { NodeSchema, Rect } from '@lc/schema'
import { childPath, nodePath } from '@lc/schema'
import { createPersistentId } from '@lc/shared'
import { DEFAULT_DROP_HEIGHT, DEFAULT_DROP_WIDTH, DROP_PREVIEW_SETTING } from './constants'
import DropOverlay from './overlay'
import { resolveSlotTarget } from './slot-target'

export { manifest } from './manifest'

function cloneNode(node: NodeSchema): NodeSchema {
  return JSON.parse(JSON.stringify(node)) as NodeSchema
}

/**
 * 落点层级：取兄弟中最大 zIndex + 1，使新节点落在最上层。
 *
 * 缺失 layout 或 zIndex 的兄弟按 0 参与比较，空兄弟列表返回 1（而非 0），
 * 与「新节点始终压在最上层」的手感一致。
 */
function nextDropZIndex(
  nodes: Readonly<Record<string, NodeSchema>>,
  siblings: readonly string[],
): number {
  const maxZ = siblings.reduce((max, id) => Math.max(max, nodes[id]?.layout?.zIndex ?? 0), 0)
  return maxZ + 1
}

/**
 * 落点矩形：以 drop 的世界坐标为中心，宽高取物料 snippet 的 rect，缺失时用默认值。
 *
 * snippet 自带的 x/y 是「复制源位置」，与落点无关，因此整体丢弃。
 */
function dropRect(snippet: NodeSchema | undefined, world: Point): Rect {
  const width = snippet?.layout?.rect?.width ?? DEFAULT_DROP_WIDTH
  const height = snippet?.layout?.rect?.height ?? DEFAULT_DROP_HEIGHT
  return { x: world.x - width / 2, y: world.y - height / 2, width, height }
}

/** 节点自转角换算成弧度：schema 按 CSS 语义存度数，几何比较一律用弧度 */
function nodeRotation(node: NodeSchema): number {
  return ((node.layout?.rotate ?? 0) * Math.PI) / 180
}

/**
 * 由物料 snippet 生成待插入节点。
 *
 * 新 id 用 createPersistentId 分配：它是 `nodes` 字典的键、会随页面落盘，
 * 进程内自增的 createId 在刷新后重新计数会撞掉已有节点。
 * 落点尺寸与层级分别见 `dropRect` 与 `nextDropZIndex`。
 * snippet 的子引用一律清空：物料里的后代节点不在本次插入范围内，留着就是悬空引用。
 */
function buildDropNode(
  entry: MaterialEntry,
  payload: CanvasDropPayload,
  nodes: Readonly<Record<string, NodeSchema>>,
  siblings: readonly string[],
): NodeSchema {
  const snippet = entry.snippet ? cloneNode(entry.snippet) : undefined

  return {
    ...(snippet ?? { componentName: entry.name }),
    id: createPersistentId('node'),
    componentName: entry.name,
    children: undefined,
    slots: undefined,
    props: snippet?.props ?? {},
    layout: {
      ...(snippet?.layout ?? {}),
      mode: 'absolute',
      rect: dropRect(snippet, payload.world),
      zIndex: nextDropZIndex(nodes, siblings),
    },
  }
}

/**
 * 物料拖入插件。
 *
 * drop 由画布宿主转成 `canvas:drop` 事件；这里负责：
 * 1. 从物料 snippet 生成节点（新 id、清除悬空子引用）
 * 2. 命中容器时挂到容器 children，物料声明了具名插槽则按落点区域挂到对应插槽，
 *    未命中容器时挂到文档根节点（见 `slot-target.ts` 的降级顺序）
 * 3. 一个事务写入一条历史，并选中新节点
 */
export default defineCanvasPlugin({
  name: 'canvas-drop',
  // material 是硬依赖：没有物料 snippet 就生成不出可插入的节点，
  // 声明成必需依赖让本插件等物料就位再激活
  inject: ['canvas', 'document', 'material'],

  apply(ctx) {
    const canvas = ctx.canvas
    const document = ctx.document
    const material = ctx.material

    ctx.effect(() =>
      canvas.settings.register({
        id: DROP_PREVIEW_SETTING,
        title: '拖入预览',
        scope: 'document',
        schema: {},
        default: null,
      }),
    )

    ctx.effect(() =>
      canvas.layers.register({
        id: 'canvas-drop.overlay',
        band: 'preview',
        pointerEvents: 'none',
        load: () => Promise.resolve({ default: DropOverlay }),
      }),
    )

    ctx.effect(() => ctx.on('canvas:drop', (payload: CanvasDropPayload) => handleDrop(payload)))

    /**
     * 一次 drop 的完整流程：解析物料 → 构建节点 → 事务提交。
     *
     * 返回 false 表示本次落入无效（未知物料 / 父节点缺失 / 事务无法开启）；
     * 无效时不清预览设置，宿主可以维持 dragover 反馈不变。
     */
    function handleDrop(payload: CanvasDropPayload): boolean {
      const entry = material.get(payload.materialName)
      if (!entry) {
        ctx.diagnostics.report(new Error(`未知物料: ${payload.materialName}`), {
          scope: 'canvas-drop',
        })
        return false
      }

      const schema = document.model.schema
      // 未命中容器时回落到文档根节点，保证任何落点都能插入
      const parentId = canvas.hitTest.containerAt(payload.screen) ?? schema.nodeId
      const parent = schema.nodes[parentId]
      if (!parent) return false

      // 分格属于容器物料，占用来自容器当前文档
      const slot = resolveSlotTarget({
        container: parent,
        slotsOf: (componentName) => material.get(componentName)?.slots,
        bounds: canvas.measure.measure(parentId),
        world: payload.world,
        rotation: nodeRotation(parent),
        materialName: entry.name,
      })
      const siblings = slot ? (parent.slots?.[slot] ?? []) : (parent.children ?? [])
      const node = buildDropNode(entry, payload, schema.nodes, siblings)
      return commitDrop(node, parentId, siblings, slot)
    }

    /**
     * 单事务提交「加节点 + 挂父」两条 patch，保证历史里只产生一步可撤销记录。
     *
     * transaction.begin 在只读文档等场景会抛错，此时按落入失败处理且不写选中集。
     */
    function commitDrop(
      node: NodeSchema,
      parentId: string,
      siblings: readonly string[],
      slot: string | undefined,
    ): boolean {
      let transaction: CanvasTransaction
      try {
        transaction = canvas.transaction.begin({ label: '添加节点', owner: 'canvas-drop' })
      } catch {
        return false
      }

      const patches: SchemaPatch[] = [
        { op: 'add', path: nodePath(node.id), value: node },
        {
          op: 'replace',
          path: childPath(parentId, slot),
          value: [...siblings, node.id],
        },
      ]
      transaction.preview(patches)
      transaction.commit()

      canvas.selection.set([node.id])
      canvas.settings.set(DROP_PREVIEW_SETTING, null)
      return true
    }
  },
})
