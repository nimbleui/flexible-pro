import type { CanvasTransaction } from '@lc/contracts'
import { defineCanvasPlugin, isPointerEvent, transformableIds } from '@lc/contracts'
import { rotateNodes, snapRadians } from './rotate'
import type { RotatableNode } from './rotate'
import RotateHandle from './overlay'

export { manifest } from './manifest'

const ROTATE_HANDLE_ID = 'rotate'

/**
 * 节点旋转插件。
 *
 * - 单选：绕组内中心旋转节点自身
 * - 多选：所有节点绕组包围盒中心旋转，同时累加各自角度
 * - 按住 Shift：按 15° 步进吸附
 * - 与缩放手柄同处 handles 层，但通过独立 handle id 与更高优先级抢占
 */
export default defineCanvasPlugin({
  name: 'canvas-rotate',
  inject: ['canvas', 'document'],

  apply(ctx) {
    const canvas = ctx.canvas
    const document = ctx.document

    ctx.effect(() =>
      canvas.layers.register({
        id: 'canvas-rotate.handle',
        band: 'handles',
        // 同 band 内压过缩放手柄：旋转圆点悬在框外，仍要与角手柄可区分地优先命中
        zIndex: 10,
        pointerEvents: 'children',
        // 与 canvas-resize 同规则：选中集全部锁定时不放手柄
        visible: (frame) => frame.selection.some((id) => !canvas.nodeFlags.locked.has(id)),
        load: () => Promise.resolve({ default: RotateHandle }),
      }),
    )

    /** 取手势起始快照：未登记几何或被锁定的 id 跳过，schema 里没有 rotate 时按 0 处理 */
    function collect(ids: readonly string[]): RotatableNode[] {
      const nodes: RotatableNode[] = []
      for (const id of transformableIds(ids, document.model.schema)) {
        const rect = canvas.scene.getBounds(id)
        if (!rect) continue
        const node = document.model.schema.nodes[id]
        nodes.push({ id, rect, rotate: node?.layout?.rotate ?? 0 })
      }
      return nodes
    }

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-rotate.gesture',
        phase: 'target',
        priority: 110,
        when: (event) =>
          isPointerEvent(event) &&
          event.type === 'pointerdown' &&
          event.targetHandleId === ROTATE_HANDLE_ID &&
          event.buttons === 1,
        handle: (event) => {
          if (!isPointerEvent(event) || event.type !== 'pointerdown') return 'pass'
          if (event.targetHandleId !== ROTATE_HANDLE_ID) return 'pass'

          const starts = collect(canvas.selection.ids)
          if (starts.length === 0) return 'pass'

          // 支点是参与旋转的这组节点外包络的中心，在按下时算一次、整场手势保持不变：
          // 单选即节点自身中心，多选是各节点 AABB 的联合中心（不随节点已旋转的角度修正）
          const bounds = canvas.scene.getBoundsOf(starts.map((node) => node.id))
          if (!bounds) return 'pass'
          const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }

          let transaction: CanvasTransaction
          try {
            transaction = canvas.transaction.begin({
              label: starts.length > 1 ? '旋转选区' : '旋转节点',
              owner: 'canvas-rotate',
            })
          } catch {
            // 事务已被别的手势占用（例如上一次未收尾）：让位，不写 patch
            return 'pass'
          }

          const startAngle = Math.atan2(event.world.y - center.y, event.world.x - center.x)

          ctx.effect(() =>
            canvas.interaction.beginGesture({
              onMove: (move) => {
                const angle = Math.atan2(move.world.y - center.y, move.world.x - center.x)
                const rawDelta = angle - startAngle
                const delta = move.modifiers.shift ? snapRadians(rawDelta) : rawDelta

                const rotated = rotateNodes(starts, center, delta)
                transaction.preview(
                  rotated.flatMap(({ id, rect, rotate }) => [
                    { op: 'replace' as const, path: `/nodes/${id}/layout/rect`, value: rect },
                    {
                      op: 'replace' as const,
                      path: `/nodes/${id}/layout/rotate`,
                      value: rotate,
                    },
                  ]),
                )
              },
              onFinish: (commit) => {
                if (commit) transaction.commit()
                else transaction.cancel()
              },
            }),
          )

          return 'stop'
        },
      }),
    )
  },
})
