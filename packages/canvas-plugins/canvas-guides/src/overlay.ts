import { defineComponent, h } from 'vue'
import type { PropType } from 'vue'
import type { CanvasFrame, CanvasService } from '@lc/contracts'
import { useAppContext } from '@lc/vue'

/**
 * 对齐辅助线覆盖层。
 *
 * 只读取 `frame.snap.guides`，不参与吸附计算；没有吸附结果时不渲染 SVG。
 * 线宽固定 1px，不随 zoom 变粗。
 */
export const GuidesOverlay = defineComponent({
  name: 'LcGuidesOverlay',
  props: {
    /** 画布帧快照 */
    frame: { type: Object as PropType<CanvasFrame>, required: true },
  },
  setup(props) {
    const ctx = useAppContext()
    const viewport = ctx.require<CanvasService>('canvas').viewport

    return () => {
      const guides = props.frame.snap?.guides ?? []
      if (guides.length === 0) return null

      const size = props.frame.size

      // 辅助线按屏幕空间绘制：线位置与 range 各取所需的一个分量（worldToScreen 含旋转，
      // 只取单分量才能得到正确轴向）。guide.axis 为 'x' 画竖线、range 落在 y 轴，
      // 与引擎约定一致，两分支互相对称。
      // range 缺省时铺满整个视口：引擎总会补上范围，这里只兜外部构造的结果。
      const lines = guides.map((guide, index) => {
        if (guide.axis === 'x') {
          const x = viewport.worldToScreen({ x: guide.value, y: 0 }).x
          const from = guide.range ? viewport.worldToScreen({ x: 0, y: guide.range[0] }).y : 0
          const to = guide.range
            ? viewport.worldToScreen({ x: 0, y: guide.range[1] }).y
            : size.height
          return h('line', {
            key: index,
            x1: x,
            y1: from,
            x2: x,
            y2: to,
            stroke: 'var(--lc-guide, #f97316)',
            'stroke-width': 1,
          })
        }

        const y = viewport.worldToScreen({ x: 0, y: guide.value }).y
        const from = guide.range ? viewport.worldToScreen({ x: guide.range[0], y: 0 }).x : 0
        const to = guide.range
          ? viewport.worldToScreen({ x: guide.range[1], y: 0 }).x
          : size.width
        return h('line', {
          key: index,
          x1: from,
          y1: y,
          x2: to,
          y2: y,
          stroke: 'var(--lc-guide, #f97316)',
          'stroke-width': 1,
        })
      })

      return h(
        'svg',
        {
          class: 'lc-guides',
          style: {
            position: 'absolute',
            inset: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            overflow: 'visible',
          },
        },
        lines,
      )
    }
  },
})

export default GuidesOverlay
