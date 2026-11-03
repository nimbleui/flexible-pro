import { defineComponent, h } from 'vue'
import type { PropType } from 'vue'
import type { CanvasFrame, CanvasService, SnapGuide } from '@lc/contracts'
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

      // 辅助线按屏幕空间绘制：guide.axis 为 'x' 画竖线、range 落在 y 轴，
      // 与引擎约定一致，两分支互相对称。
      const lines = guides.map((guide, index) =>
        guide.axis === 'x'
          ? renderVerticalGuide(viewport, guide, index, size)
          : renderHorizontalGuide(viewport, guide, index, size),
      )

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

interface GuideViewportSize {
  /** 舞台宽（屏幕 CSS 像素），无 range 时横线铺满到此 */
  width: number
  /** 舞台高（屏幕 CSS 像素），无 range 时竖线铺满到此 */
  height: number
}

/**
 * 竖线：axis 'x' 的辅助线，value 在世界 X、range 在世界 Y。
 *
 * worldToScreen 含旋转，只取单分量才能得到正确轴向；range 缺省时
 * 铺满整个视口——引擎总会补上范围，这里只兜外部构造的结果。
 */
function renderVerticalGuide(
  viewport: CanvasService['viewport'],
  guide: SnapGuide,
  key: number,
  size: GuideViewportSize,
): ReturnType<typeof h> {
  const x = viewport.worldToScreen({ x: guide.value, y: 0 }).x
  const from = guide.range ? viewport.worldToScreen({ x: 0, y: guide.range[0] }).y : 0
  const to = guide.range ? viewport.worldToScreen({ x: 0, y: guide.range[1] }).y : size.height

  return h('line', {
    key,
    x1: x,
    y1: from,
    x2: x,
    y2: to,
    stroke: 'var(--lc-guide, #f97316)',
    'stroke-width': 1,
  })
}

/** 横线：axis 'y' 的辅助线，与竖线分支关于两轴对称 */
function renderHorizontalGuide(
  viewport: CanvasService['viewport'],
  guide: SnapGuide,
  key: number,
  size: GuideViewportSize,
): ReturnType<typeof h> {
  const y = viewport.worldToScreen({ x: 0, y: guide.value }).y
  const from = guide.range ? viewport.worldToScreen({ x: guide.range[0], y: 0 }).x : 0
  const to = guide.range ? viewport.worldToScreen({ x: guide.range[1], y: 0 }).x : size.width

  return h('line', {
    key,
    x1: from,
    y1: y,
    x2: to,
    y2: y,
    stroke: 'var(--lc-guide, #f97316)',
    'stroke-width': 1,
  })
}

export default GuidesOverlay
