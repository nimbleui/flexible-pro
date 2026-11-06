import { createScheduler, createViewport, unionRects } from '@lc/canvas'
import type { Point, Rect } from '@lc/contracts'
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import { toastService } from '../../../toast'
import { flowNodeRect } from '../constants/node-tone'
import { firstFreePosition } from '../utils/node-placement'
import { layoutFlowEdges } from '../utils/edge-path'
import { projectToMinimap } from '../utils/minimap'
import type { FlowEdgeRejection, FlowEditorHandle } from './use-flow-editor'

/**
 * 流程画布的视口与指针手势。
 *
 * ## 为什么只用 `@lc/canvas` 的原语而不是整套画布服务
 *
 * `service-canvas-core` 与 `canvas-selection` / `canvas-drag` 都 `require('document')`，
 * 读的是 `PageSchema` 的节点树。流程图是另一份文档，套过去要么伪造一个 document 服务、
 * 要么把图塞进 nodes 表——两者都是为了让插件复用而扭曲数据形状。
 * 视口与调度器是纯计算，没有这个问题，所以直接拿来用：矩阵推导、围绕指针缩放、
 * NaN 夹紧、后台标签页兜底这些坑不必再踩一遍。
 */

/** 缩放下限：再小节点文字就不可读了，看全貌有「适应画布」 */
const MIN_ZOOM = 0.25

/** 缩放上限 */
const MAX_ZOOM = 3

/** 滚轮缩放系数，与画布缩放插件保持一致，避免两处手感不同 */
const WHEEL_ZOOM_FACTOR = 0.0015

/** 小地图的画布尺寸（CSS 像素） */
const MINIMAP_SIZE = { width: 188, height: 128 }

/** 小地图四周留白 */
const MINIMAP_PADDING = 8

/**
 * 拉线被拒绝时的提示文案。
 *
 * `addEdge` 原来静默返回 `undefined`，作者在画布上看不到任何原因，只能得出
 * 「画布连不上线」的结论；把拒绝原因写成一句可见的提示，才有下一步可做的事。
 */
const EDGE_REJECT_TEXT: Record<FlowEdgeRejection, string> = {
  self: '不能把节点连到自己',
  duplicate: '这两个节点之间已经有连线',
  'missing-node': '节点已不在图上，连线未创建',
}

/** 当前进行中的手势 */
type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; /** 上一帧的屏幕坐标，用于增量平移视口 */ lastScreen: Point }
  | {
      kind: 'move-node'
      /** 被拖动的节点 id */ nodeId: string
      /** 按下点与节点左上角的差，拖动时保持卡片跟着指针而不是跳中心 */ grabOffset: Point
    }
  | {
      kind: 'connect'
      /** 拉线的源节点 id */ sourceId: string
      /** 临时连线的起点，取源节点输出锚点 */ from: Point
    }

/** 节点输出锚点：底边中点，端口拉线与 Alt 拉线取同一个点 */
function bottomAnchor(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height }
}

/** 指针按下时命中的对象 */
interface HitTarget {
  nodeId: string | null
  isOutputPort: boolean
  isStageBackground: boolean
}

/** 从事件目标推导命中对象；只认画布自己标注的两个 data 属性 */
function resolveTarget(target: EventTarget | null): HitTarget {
  const element = target instanceof Element ? target : null
  const port = element?.closest<HTMLElement>('[data-flow-port="out"]') ?? null
  const node = element?.closest<HTMLElement>('[data-flow-node]') ?? null

  return {
    nodeId: node?.dataset.flowNode ?? null,
    isOutputPort: port !== null,
    isStageBackground:
      element instanceof HTMLElement && element.hasAttribute('data-flow-stage'),
  }
}

export function useFlowCanvas(editor: FlowEditorHandle) {
  const viewport = createViewport({ minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM })
  const scheduler = createScheduler()

  /** 内容层的 CSS transform；由帧回调整体替换而不是 computed，见 CanvasStage 的同款注释 */
  const transform = shallowRef('matrix(1, 0, 0, 1, 0, 0)')
  const zoomPercent = computed(() => Math.round(viewport.state.zoom * 100))

  const stageRef = shallowRef<HTMLElement | null>(null)
  const gesture = shallowRef<Gesture>({ kind: 'none' })
  /** 正在拉出的临时连线；只在手势期间存在，不进文档 */
  const pendingEdge = shallowRef<{ from: Point; to: Point } | null>(null)
  /** 拉线时悬停的可连接节点 */
  const connectTargetId = shallowRef<string | null>(null)

  const disposables: Array<{ dispose(): void }> = []

  /** 舞台本地屏幕坐标：以 getBoundingClientRect 为原点，与 viewport 的约定一致 */
  function toScreenPoint(event: PointerEvent | WheelEvent): Point {
    const element = stageRef.value
    if (!element) return { x: 0, y: 0 }
    const rect = element.getBoundingClientRect()

    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  function toWorldPoint(event: PointerEvent | WheelEvent): Point {
    return viewport.screenToWorld(toScreenPoint(event))
  }

  /** 节点世界矩形表，连线布局与小地图共用 */
  const nodeRects = computed<Map<string, Rect>>(() => {
    const map = new Map<string, Rect>()
    const flow = editor.flow.value
    if (!flow) return map

    for (const node of Object.values(flow.nodes)) map.set(node.id, flowNodeRect(node))

    return map
  })

  const edgeRoutes = computed(() => {
    const flow = editor.flow.value

    return flow ? layoutFlowEdges(flow, nodeRects.value) : new Map()
  })

  /** 全部节点的并集矩形；无节点时为 null，由 fit 自己短路 */
  const graphBounds = computed<Rect | null>(
    () => unionRects([...nodeRects.value.values()]) ?? null,
  )

  const minimap = computed(() => {
    const bounds = graphBounds.value
    if (!bounds) return null

    const projection = projectToMinimap(bounds, MINIMAP_SIZE, MINIMAP_PADDING)
    const { zoom, x, y } = viewport.state

    return {
      projection,
      size: MINIMAP_SIZE,
      nodes: [...nodeRects.value.entries()].map(([id, rect]) => ({
        id,
        ...projection.project(rect),
      })),
      viewportRect: projection.project({
        x,
        y,
        width: viewport.size.width / zoom,
        height: viewport.size.height / zoom,
      }),
    }
  })

  function refreshTransform(): void {
    transform.value = `matrix(${viewport.matrix.join(', ')})`
  }

  /**
   * 把整张图摆进可视区。
   *
   * 尺寸未测得时 `fit` 会静默返回，所以挂载后必须先 `setSize` 再调用。
   */
  function fitToScreen(): void {
    const bounds = graphBounds.value
    if (!bounds) return
    viewport.fit({
      ...bounds,
      x: bounds.x - 40,
      y: bounds.y - 40,
      width: bounds.width + 80,
      height: bounds.height + 80,
    })
  }

  /** 以当前缩放把图居中，不改 zoom：图比视口小时用 fit 会把节点放大到铺满，卡片细节糊成一团 */
  function centerGraph(): void {
    const bounds = graphBounds.value
    const { width, height, zoom } = { ...viewport.size, zoom: viewport.state.zoom }
    if (!bounds || width === 0 || height === 0) return

    viewport.set({
      x: bounds.x + bounds.width / 2 - width / 2 / zoom,
      y: bounds.y + bounds.height / 2 - height / 2 / zoom,
    })
  }

  /**
   * 首帧取景：100% 装得下就居中，装不下就整体缩进视口。
   *
   * 只居中会在长图上把入口节点推出画面——舞台是 `overflow: hidden`，画布也没有滚动条，
   * 于是第一个节点既看不见也点不到，唯一出路是用户自己发现「适应画布」按钮。
   * 内置示例审批链正是这一类（图 906px 高对 614px 舞台，开始节点落在舞台上方 146px 处）。
   *
   * 反过来只 fit 也不行：三两个节点的图会被放大到铺满整屏，所以尺寸够用时保留 100%。
   */
  function frameGraph(): void {
    const bounds = graphBounds.value
    const { width, height } = viewport.size
    if (!bounds || width === 0 || height === 0) return

    if (bounds.width <= width && bounds.height <= height) {
      centerGraph()
      return
    }

    fitToScreen()
  }

  function zoomBy(factor: number): void {
    viewport.zoomAt({ x: viewport.size.width / 2, y: viewport.size.height / 2 }, factor)
  }

  function zoomReset(): void {
    viewport.set({ zoom: 1 })
    centerGraph()
  }

  /** 落点：把节点摆到指针处（从节点库拖入）或视口中心（点击条目） */
  function worldPointAtScreen(screen: Point): Point {
    return viewport.screenToWorld(screen)
  }

  /** 视口中心的世界坐标 */
  function viewCenterWorld(): Point {
    return viewport.screenToWorld({ x: viewport.size.width / 2, y: viewport.size.height / 2 })
  }

  /**
   * 把节点库拖入的落点收敛到节点左上角，避免指针压在卡片正中导致视觉跳动。
   *
   * 顺带避让已有节点：点击条目时落点恒为视口中心，不避让的话连续添加的卡片会精确
   * 重叠，端口互相压住，拉线时起止点被解析成同一个节点，连线再也出不来。
   */
  function anchorForInsertion(world: Point, size: { width: number; height: number }): Point {
    const centered = {
      x: Math.round(world.x - size.width / 2),
      y: Math.round(world.y - size.height / 2),
    }

    return firstFreePosition(centered, size, [...nodeRects.value.values()])
  }

  /**
   * 手势期间把 move / up 挂到 window 上。
   *
   * 不用 `setPointerCapture`：捕获一旦失败或被系统回收（触屏、笔输入、窗口失焦），
   * 指针移出舞台后就再也收不到事件，`beginGesture` 开的那段历史基线永远等不到
   * `endGesture`，撤销栈会漏掉这次拖动。挂在 window 上不依赖捕获，移出画面也能继续拖。
   */
  function attachGestureListeners(): void {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }

  function detachGestureListeners(): void {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
  }

  /**
   * 按下起线：抓底部输出端口，或按住 Alt 从卡片任意位置按下。
   *
   * 不按 Alt 时卡片中部拖动仍然只移动节点——两种手势不能抢同一个按下事件。
   * 端口那条路保持可用是有意为之：触屏与触控笔没有修饰键，不能只剩 Alt 一条路。
   */
  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 && event.button !== 1) return
    if (!stageRef.value) return

    const hit = resolveTarget(event.target)
    const world = toWorldPoint(event)

    if ((hit.isOutputPort || event.altKey) && hit.nodeId) {
      const source = nodeRects.value.get(hit.nodeId)
      const rect = source ?? { x: world.x, y: world.y, width: 0, height: 0 }

      gesture.value = { kind: 'connect', sourceId: hit.nodeId, from: bottomAnchor(rect) }
      pendingEdge.value = { from: gesture.value.from, to: world }
      attachGestureListeners()
      return
    }

    if (hit.nodeId) {
      const node = editor.flow.value?.nodes[hit.nodeId]
      if (!node) return

      editor.selectNode(hit.nodeId)
      editor.beginGesture()
      gesture.value = {
        kind: 'move-node',
        nodeId: hit.nodeId,
        grabOffset: { x: world.x - node.position.x, y: world.y - node.position.y },
      }
      attachGestureListeners()
      return
    }

    if (hit.isStageBackground) {
      editor.selectNode(null)
      editor.selectEdge(null)
    }

    gesture.value = { kind: 'pan', lastScreen: toScreenPoint(event) }
    attachGestureListeners()
  }

  function onPointerMove(event: PointerEvent): void {
    const current = gesture.value
    if (current.kind === 'none') return

    if (current.kind === 'pan') {
      const screen = toScreenPoint(event)
      viewport.panBy({ x: screen.x - current.lastScreen.x, y: screen.y - current.lastScreen.y })
      gesture.value = { kind: 'pan', lastScreen: screen }
      return
    }

    const world = toWorldPoint(event)

    if (current.kind === 'move-node') {
      editor.moveNode(current.nodeId, {
        x: Math.round(world.x - current.grabOffset.x),
        y: Math.round(world.y - current.grabOffset.y),
      })
      return
    }

    pendingEdge.value = { from: current.from, to: world }
    const hit = resolveTarget(event.target)
    connectTargetId.value = hit.nodeId && hit.nodeId !== current.sourceId ? hit.nodeId : null
  }

  function onPointerUp(event: PointerEvent): void {
    const current = gesture.value
    detachGestureListeners()

    if (current.kind === 'move-node') editor.endGesture()

    if (current.kind === 'connect') {
      // 松在空白处算「取消拉线」，不提示；落在节点上却被规则拒绝时必须说清原因，
      // 否则作者只看到线弹回去，得到的结论是画布连不上线
      const targetId = resolveTarget(event.target).nodeId
      if (targetId) {
        const result = editor.addEdge(current.sourceId, targetId)
        if (!result.ok) toastService.show(EDGE_REJECT_TEXT[result.reason], 'warning')
      }
    }

    pendingEdge.value = null
    connectTargetId.value = null
    gesture.value = { kind: 'none' }
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault()

    if (event.ctrlKey || event.metaKey) {
      viewport.zoomAt(toScreenPoint(event), Math.exp(-event.deltaY * WHEEL_ZOOM_FACTOR))
      return
    }

    viewport.panBy({ x: -event.deltaX, y: -event.deltaY })
  }

  /** 小地图上的指针操作：把视口中心搬到点击处 */
  function focusMinimapPoint(screenInMinimap: Point): void {
    const map = minimap.value
    if (!map) return

    const world = map.projection.invert(screenInMinimap)
    const { zoom } = viewport.state

    viewport.set({
      x: world.x - viewport.size.width / 2 / zoom,
      y: world.y - viewport.size.height / 2 / zoom,
    })
  }

  onMounted(() => {
    const element = stageRef.value
    if (!element) return

    // attach 之前先测一次尺寸，否则首帧的取景会拿到 0×0 而什么都不摆
    const measure = () => {
      const rect = element.getBoundingClientRect()
      viewport.setSize({ width: rect.width, height: rect.height })
    }
    measure()
    frameGraph()

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    disposables.push({ dispose: () => observer.disconnect() })
    disposables.push(viewport.onDidChange(() => scheduler.invalidateViewport()))
    disposables.push(scheduler.onFrame(refreshTransform))
    refreshTransform()
  })

  onUnmounted(() => {
    // 手势没结束就卸载（例如切路由）：先摘掉 window 监听，再释放订阅，
    // 否则残留的 pointermove 会继续写一个已经没有主人的工作副本
    detachGestureListeners()
    for (const disposable of disposables.reverse()) disposable.dispose()
    disposables.length = 0
    scheduler.dispose()
  })

  return {
    stageRef,
    transform,
    zoomPercent,
    gesture,
    pendingEdge,
    connectTargetId,
    nodeRects,
    edgeRoutes,
    graphBounds,
    minimap,
    worldPointAtScreen,
    viewCenterWorld,
    anchorForInsertion,
    fitToScreen,
    centerGraph,
    zoomBy,
    zoomReset,
    focusMinimapPoint,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onWheel,
    },
  }
}
