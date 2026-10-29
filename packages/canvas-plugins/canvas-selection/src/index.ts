import { defineCanvasPlugin } from '@lc/contracts'
import { normalizeRect } from '@lc/canvas'
import type { Rect } from '@lc/schema'
import { MARQUEE_SETTING } from './constants'
import SelectionOverlay from './overlay'

export { manifest } from './manifest'

/** 设置面板里的展示名；与 MARQUEE_SETTING 的 id 分开，改文案不影响订阅 */
const MARQUEE_LABEL = '框选矩形'

/**
 * 选择插件。
 *
 * - 点选节点：更新选中集后返回 pass，让拖拽插件继续接管；
 * - Shift 点选：切换选中，消费事件不再拖拽；
 * - 空白拖动：清空选中并开始框选（框选矩形写入画布设置，覆盖层读取绘制）。
 */
export default defineCanvasPlugin({
  name: 'canvas-selection',
  inject: ['canvas'],

  apply(ctx) {
    const canvas = ctx.canvas

    ctx.effect(() =>
      canvas.settings.register<Rect | null>({
        id: MARQUEE_SETTING,
        title: MARQUEE_LABEL,
        scope: 'document',
        schema: {},
        default: null,
      }),
    )

    ctx.effect(() =>
      canvas.layers.register({
        id: 'canvas-selection.overlay',
        band: 'selection',
        pointerEvents: 'none',
        load: () => Promise.resolve({ default: SelectionOverlay }),
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-selection.click',
        priority: 65,
        when: (event) =>
          event.type === 'click' && Boolean(event.targetNodeId) && !event.modifiers.shift,
        handle: (event) => {
          if (event.type !== 'click' || !event.targetNodeId) return 'pass'
          // 点击（无拖动）已多选的节点时收敛为单选；拖动场景由管线抑制 click，不受影响
          if (canvas.selection.ids.length > 1) {
            canvas.selection.set([event.targetNodeId])
          }
          return 'pass'
        },
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-selection.pointer',
        phase: 'bubble',
        // 必须早于 canvas-drag：先更新选中集，再让拖拽读取最新选中
        priority: 70,
        when: (event) =>
          event.type === 'pointerdown' && event.buttons === 1 && !event.targetHandleId,
        handle: (event) => {
          if (event.type !== 'pointerdown') return 'pass'

          if (event.targetNodeId) {
            if (event.modifiers.shift) {
              canvas.selection.toggle(event.targetNodeId)
              return 'handled'
            }
            if (!canvas.selection.ids.includes(event.targetNodeId)) {
              canvas.selection.set([event.targetNodeId])
            }
            // pass：拖拽插件需要收到同一次 pointerdown
            return 'pass'
          }

          if (!event.modifiers.shift) canvas.selection.clear()

          const start = event.world
          /**
           * 框选实时更新：世界矩形写进设置供覆盖层绘制，命中判定必须换回屏幕矩形
           * （hitTest.inRect 收的是屏幕坐标）。
           *
           * 世界 AABB 与屏幕 AABB 不等价，因此这里重新换算而不是复用 marquee；
           * 每帧写设置会触发一次设置订阅通知，覆盖层据此重绘。
           */
          const applyMarquee = (world: { x: number; y: number }): void => {
            const marquee = normalizeRect(start, world)
            canvas.settings.set(MARQUEE_SETTING, marquee)

            const topLeft = canvas.viewport.worldToScreen({ x: marquee.x, y: marquee.y })
            const bottomRight = canvas.viewport.worldToScreen({
              x: marquee.x + marquee.width,
              y: marquee.y + marquee.height,
            })
            const screenRect = normalizeRect(topLeft, bottomRight)
            canvas.selection.set(canvas.hitTest.inRect(screenRect))
          }

          ctx.effect(() =>
            canvas.interaction.beginGesture({
              onMove: (move) => applyMarquee(move.world),
              // 抬手清空临时矩形，覆盖层随即停止绘制；选中结果已经落到 selection 服务
              onFinish: () => canvas.settings.set(MARQUEE_SETTING, null),
            }),
          )

          return 'handled'
        },
      }),
    )
  },
})
