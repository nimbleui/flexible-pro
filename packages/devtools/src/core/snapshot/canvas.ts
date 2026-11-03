import type { Context } from '@lc/kernel'
import type { CanvasService, DocumentService, HistoryService } from '@lc/contracts'
import type { CanvasView } from '../types'

/**
 * 视口快照：逐字段拷成普通数，避免面板持有 `ViewportService.state` 的活引用。
 *
 * `width` / `height` 是可视区的屏幕像素（由 CanvasStage 的 ResizeObserver 写入），
 * 与 `x` / `y` 的世界坐标不在同一坐标空间。
 */
function viewportSnapshot(service: CanvasService): CanvasView['viewport'] {
  const state = service.viewport.state
  return {
    x: state.x,
    y: state.y,
    zoom: state.zoom,
    rotation: state.rotation,
    width: service.viewport.size.width,
    height: service.viewport.size.height,
  }
}

/**
 * 场景快照：节点数、登记顺序与文档根包围盒。
 *
 * `order` 直接引用 `SceneService.list()` 的内部数组（契约要求只读，一次重算只多一个引用）；
 * `count` 与 `order` 取自同一次调用，不会出现数目与列表不一致的中间态。
 */
function sceneSnapshot(service: CanvasService): CanvasView['scene'] {
  const order = service.scene.list()
  return {
    count: order.length,
    order,
    rootBounds: service.scene.getRootBounds(),
  }
}

/** 覆盖层视图：缺省值按渲染层的实际解释补齐，避免面板把「未设置」显示成空白。 */
function layerViews(service: CanvasService): CanvasView['layers'] {
  return service.layers.list().map((layer) => ({
    id: layer.id,
    band: layer.band,
    zIndex: layer.zIndex ?? 0,
    pointerEvents: layer.pointerEvents ?? 'none',
  }))
}

/** 交互处理器视图：phase 与 priority 的内核默认值和分发器保持一致。 */
function handlerViews(service: CanvasService): CanvasView['handlers'] {
  return service.interaction.list().map((handler) => ({
    id: handler.id,
    phase: handler.phase ?? 'bubble',
    priority: handler.priority ?? 0,
  }))
}

/** 文档摘要：没有文档服务或文档模型时返回 null，面板据此显示空态。 */
function documentSummary(document: DocumentService | undefined): CanvasView['document'] {
  const model = document?.model
  if (!model) return null

  const schema = model.schema
  return {
    id: model.id,
    title: model.title,
    schemaVersion: schema?.version ?? '-',
    revision: model.version,
    nodeCount: schema ? Object.keys(schema.nodes).length : 0,
    dirty: model.dirty,
  }
}

/** 撤销/重做摘要：历史条数来自 `list()`，只取长度不保留条目引用。 */
function historySummary(history: HistoryService | undefined): CanvasView['history'] {
  if (!history) return null
  return { canUndo: history.canUndo, canRedo: history.canRedo, count: history.list().length }
}

/**
 * 画布视图快照：视口、场景、覆盖层、交互处理器、选中集与文档状态。
 *
 * 采集只做读取与展平，不调用任何会改变画布的方法；面板每次重算都会重新走一遍，
 * 因此这里必须是「某一时刻的状态」而不是服务的活引用。
 *
 * 引用共享的取舍（逐字段拷平的部分见 `viewportSnapshot` / `sceneSnapshot`）：
 * - `selection.ids` 是服务的只读视图，随选中变化整体替换，保留引用无副作用。
 * - `nodeFlags` 的两个 Set 会被交互实时增删，因此展开成数组复制。
 * - 覆盖层与处理器逐项展平成普通对象，保证面板可序列化。
 *
 * 容量：本函数不截断任何列表，长 id 列表的展示上限由 CanvasPanel 的 PREVIEW_LIMIT 负责。
 */
export function buildCanvasView(canvas: Context | null | undefined): CanvasView | null {
  if (!canvas) return null
  const service = canvas.get<CanvasService>('canvas')
  if (!service) return null

  const document = canvas.get<DocumentService>('document')
  const history = canvas.get<HistoryService>('history')

  return {
    viewport: viewportSnapshot(service),
    scene: sceneSnapshot(service),
    layers: layerViews(service),
    handlers: handlerViews(service),
    selection: {
      ids: service.selection.ids,
      primary: service.selection.primary ?? null,
    },
    flags: {
      hidden: [...service.nodeFlags.hidden],
      locked: [...service.nodeFlags.locked],
    },
    document: documentSummary(document),
    history: historySummary(history),
  }
}
