import type { CanvasTransaction } from '@lc/contracts'
import { defineCanvasPlugin, isPointerEvent, transformableIds } from '@lc/contracts'
import type { Rect } from '@lc/schema'
import { resizeRotatedRect, resizeRect, scaleSelection } from './geometry'
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
  inject: ['canvas', 'document'],

  apply(ctx) {
    const canvas = ctx.canvas
    const document = ctx.document

    ctx.effect(() =>
      canvas.layers.register({
        id: 'canvas-resize.handles',
        band: 'handles',
        // children：层本身不挡命中，只有手柄元素可被指针命中并带上 data-handle-id
        pointerEvents: 'children',
        // 整组都被锁定时不放手柄：手势起始处会过滤掉锁定节点，手柄点了也只是空转
        visible: (frame) => frame.selection.some((id) => !canvas.nodeFlags.locked.has(id)),
        load: () => Promise.resolve({ default: ResizeHandles }),
      }),
    )

    /** 取场景里已登记几何、且允许变换的选中节点；未登记或被锁定的 id 静默跳过 */
    function collectSelection(ids: readonly string[]): SelectionNode[] {
      const nodes: SelectionNode[] = []
      for (const id of transformableIds(ids, document.model.schema)) {
        const rect = canvas.scene.getBounds(id)
        if (rect) nodes.push({ id, rect })
      }
      return nodes
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
                  const next = resizeRotatedRect({
                    rect: startBounds,
                    rotation: startRotation,
                    handleId,
                    point: move.world,
                    keepAspect,
                  })
                  transaction.preview([
                    { op: 'replace', path: `/nodes/${single.id}/layout/rect`, value: next },
                  ])
                  return
                }

                // 多选：组框轴对齐缩放，各节点旋转保持不变
                const nextBounds = resizeRect(startBounds, handleId, move.world, { keepAspect })
                const scaled = scaleSelection(starts, startBounds, nextBounds)
                transaction.preview(
                  scaled.map(({ id, rect }) => ({
                    op: 'replace',
                    path: `/nodes/${id}/layout/rect`,
                    value: rect,
                  })),
                )
              },
              onFinish: (commit) => {
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
