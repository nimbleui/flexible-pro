import type { CanvasModifiers, CanvasTransaction, SnapService } from '@lc/contracts'
import {
  defineCanvasPlugin,
  handleTargetIds,
  isPointerEvent,
  transformableIds,
} from '@lc/contracts'
import { normalizeRect } from '@lc/canvas'
import type { Rect } from '@lc/schema'
import { createNodeLayoutPatch } from '@lc/schema'
import {
  applyEdgeSnap,
  edgeModesOf,
  resizeRect,
  resizeRotatedRect,
  scaleSelection,
} from './geometry'
import type { SelectionNode } from './geometry'
import ResizeHandles from './overlay'

export { manifest } from './manifest'

/** 旋转手柄由 canvas-rotate 处理，缩放手柄必须让位 */
const ROTATE_HANDLE_ID = 'rotate'

/**
 * 缩放插件。
 *
 * - 单选：在节点局部坐标系缩放，旋转后的节点对侧锚点在世界空间保持不动
 * - 多选：以选中集包围盒为组框整体缩放，节点自身旋转保持不变
 * - Shift 保持宽高比（仅角手柄）
 * - 手柄手势独占（target 阶段、优先级 100），一次手势只产生一条历史
 */
export default defineCanvasPlugin({
  name: 'canvas-resize',
  inject: { required: ['canvas', 'document'], optional: ['snap'] },

  apply(ctx) {
    const canvas = ctx.canvas
    const document = ctx.document
    const snap = ctx.snap

    ctx.effect(() =>
      canvas.layers.register({
        id: 'canvas-resize.handles',
        band: 'handles',
        // children：层本身不挡命中，只有手柄元素可被指针命中并带上 data-handle-id
        pointerEvents: 'children',
        // 选区里没有「出得了手柄的节点」时不放手柄：画幅根与被锁定节点都会在手势
        // 起始处被过滤掉，留着手柄只会让人对着点了不动的框空转
        visible: (frame) => handleTargetIds(frame.selection, canvas.nodeFlags).length > 0,
        load: () => Promise.resolve({ default: ResizeHandles }),
      }),
    )

    /** 取场景里已登记几何、且允许变换的选中节点；画幅根、锁定或未登记的 id 静默跳过 */
    function collectSelection(ids: readonly string[]): SelectionNode[] {
      const nodes: SelectionNode[] = []
      for (const id of transformableIds(ids, document.model.schema)) {
        const rect = canvas.scene.getBounds(id)
        if (rect) nodes.push({ id, rect })
      }
      return nodes
    }

    /**
     * 视口对应的世界矩形，作为吸附候选的裁剪范围。
     *
     * 只换算左上、右下两角：视口 rotation 为 0 时准确，旋转后得到偏小的 AABB，
     * 与拖拽插件同口径，按粗筛理解。
     */
    function viewportWorldRect(): Rect {
      const topLeft = canvas.viewport.screenToWorld({ x: 0, y: 0 })
      const bottomRight = canvas.viewport.screenToWorld({
        x: canvas.viewport.size.width,
        y: canvas.viewport.size.height,
      })
      return normalizeRect(topLeft, bottomRight)
    }

    /** 清空吸附结果：服务没有显式 clear，用空 rects 的解析把残留辅助线撤掉 */
    function clearSnap(service: SnapService, ids: readonly string[]): void {
      service.resolve({
        rects: [],
        zoom: canvas.viewport.state.zoom,
        viewportRect: viewportWorldRect(),
        movingIds: ids,
      })
    }

    /**
     * 手柄吸附：只吸正在拖的那条边。
     *
     * Shift（等比）与 Alt（临时关闭吸附）都与逐边吸附冲突，直接跳过并清掉残留
     * 辅助线；旋转节点的边不与世界轴对齐，调用方会在旋转分支里绕开本函数。
     */
    function withSnap(
      rect: Rect,
      handleId: string,
      move: { modifiers: CanvasModifiers },
      movingIds: readonly string[],
    ): Rect {
      if (!snap) return rect
      if (move.modifiers.shift || move.modifiers.alt) {
        clearSnap(snap, movingIds)
        return rect
      }

      const result = snap.resolve({
        rects: [rect],
        zoom: canvas.viewport.state.zoom,
        viewportRect: viewportWorldRect(),
        movingIds,
        edges: edgeModesOf(handleId),
      })
      return result.matched ? applyEdgeSnap(rect, handleId, result.delta) : rect
    }

    /** schema 里的 rotate 是角度，几何计算一律用弧度；节点缺失或未写旋转时取 0 */
    function rotationOf(nodeId: string): number {
      const degrees = document.model.schema.nodes[nodeId]?.layout?.rotate ?? 0
      return (degrees * Math.PI) / 180
    }

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-resize.handle',
        phase: 'target',
        priority: 100,
        when: (event) =>
          isPointerEvent(event) &&
          event.type === 'pointerdown' &&
          Boolean(event.targetHandleId) &&
          event.targetHandleId !== ROTATE_HANDLE_ID &&
          event.buttons === 1,
        handle: (event) => {
          if (!isPointerEvent(event) || event.type !== 'pointerdown') return 'pass'
          const handleId = event.targetHandleId
          if (!handleId || handleId === ROTATE_HANDLE_ID) return 'pass'

          const starts = collectSelection(canvas.selection.ids)
          if (starts.length === 0) return 'pass'

          const single = starts.length === 1 ? (starts[0] as SelectionNode) : null
          const startBounds = unionBounds(starts)
          if (!startBounds) return 'pass'
          const startRotation = single ? rotationOf(single.id) : 0

          let transaction: CanvasTransaction
          try {
            transaction = canvas.transaction.begin({
              label: single ? '缩放节点' : '缩放选区',
              owner: 'canvas-resize',
            })
          } catch {
            // 上一次手势的事务尚未收尾：让位，本次缩放不写任何 patch
            return 'pass'
          }

          ctx.effect(() =>
            canvas.interaction.beginGesture({
              onMove: (move) => {
                const keepAspect = move.modifiers.shift

                // 单选：旋转感知缩放，对侧锚点在世界空间保持不动
                if (single) {
                  const raw = resizeRotatedRect({
                    rect: startBounds,
                    rotation: startRotation,
                    handleId,
                    point: move.world,
                    keepAspect,
                  })
                  // 旋转后的「边」不沿世界轴，按轴吸附会改可视尺寸而不是对齐，直接跳过
                  const next =
                    startRotation === 0 ? withSnap(raw, handleId, move, [single.id]) : raw
                  transaction.preview(createNodeLayoutPatch(single.id, { rect: next }))
                  return
                }

                // 多选：组框轴对齐缩放，各节点旋转保持不变
                const bounds = resizeRect(startBounds, handleId, move.world, { keepAspect })
                const nextBounds = withSnap(
                  bounds,
                  handleId,
                  move,
                  starts.map(({ id }) => id),
                )
                const scaled = scaleSelection(starts, startBounds, nextBounds)
                transaction.preview(
                  scaled.flatMap(({ id, rect }) => createNodeLayoutPatch(id, { rect })),
                )
              },
              onFinish: (commit) => {
                if (snap)
                  clearSnap(
                    snap,
                    starts.map(({ id }) => id),
                  )
                if (commit) transaction.commit()
                else transaction.cancel()
              },
            }),
          )

          // 手柄手势独占，阻止冒泡触发节点拖拽
          return 'stop'
        },
      }),
    )
  },
})

/**
 * 选中集的世界包围盒（AABB），多选缩放的组框基准。
 *
 * 只在按下手柄时算一次：手势期间各节点几何被 preview 改写，基准必须停留在
 * 起始状态，否则比例映射会逐帧漂移。空集合返回 undefined。
 */
function unionBounds(nodes: readonly SelectionNode[]): Rect | undefined {
  if (nodes.length === 0) return undefined

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const { rect } of nodes) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
