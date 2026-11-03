import { defineComponent, h } from 'vue'
import type { CSSProperties, PropType } from 'vue'
import type { CanvasFrame, CanvasService, DocumentService } from '@lc/contracts'
import { useAppContext } from '@lc/vue'
import { placeRotateHandle } from './rotate'
import type { RotateHandlePlacement } from './rotate'

/** 旋转手柄到包围盒顶边的屏幕距离 */
const HANDLE_OFFSET = 28

/** 手柄直径（屏幕像素）：固定尺寸，不随 zoom 变化 */
const HANDLE_SIZE = 16

/**
 * 手柄本体外观：直径、配色、光标全部固定，只有落点随选区移动。
 *
 * 提到模块级常量，避免每帧渲染重建同构字面量；尺寸是屏幕 CSS 像素，
 * 不做 zoom 与设备像素比换算。
 */
const KNOB_STYLE: CSSProperties = {
  position: 'absolute',
  width: `${HANDLE_SIZE}px`,
  height: `${HANDLE_SIZE}px`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '50%',
  background: 'var(--lc-handle-bg, #ffffff)',
  border: '1px solid var(--lc-accent, #2563eb)',
  color: 'var(--lc-accent, #2563eb)',
  fontSize: '10px',
  lineHeight: 1,
  cursor: 'grab',
  pointerEvents: 'auto',
  userSelect: 'none',
}

/**
 * 旋转手柄覆盖层。
 *
 * - 单选：手柄绕节点中心跟随节点旋转，始终贴在旋转后的顶边外侧
 * - 多选：手柄固定在选中集包围盒顶边中点上方
 * 屏幕空间绘制，尺寸不随 zoom 变化。
 */
export const RotateHandle = defineComponent({
  name: 'LcRotateHandle',
  props: {
    /** 画布帧快照 */
    frame: { type: Object as PropType<CanvasFrame>, required: true },
  },
  setup(props) {
    const ctx = useAppContext()
    const canvas = ctx.require<CanvasService>('canvas')
    const document = ctx.require<DocumentService>('document')

    /**
     * 求当前选区的手柄落点（屏幕空间）。
     *
     * 无选中、包围盒缺失（节点已删除等瞬态）时返回 null，覆盖层整体不渲染。
     */
    function computePlacement(): RotateHandlePlacement | null {
      const selection = props.frame.selection
      if (selection.length === 0) return null

      const singleId = selection.length === 1 ? (selection[0] as string) : null
      const bounds = singleId
        ? canvas.scene.getBounds(singleId)
        : canvas.scene.getBoundsOf(selection)
      if (!bounds) return null

      // 多选没有单一 rotate 可跟随，按 0 度退化为 AABB 顶边
      const rotationDeg = singleId
        ? (document.model.schema.nodes[singleId]?.layout?.rotate ?? 0)
        : 0
      const rotation = (rotationDeg * Math.PI) / 180

      const center = canvas.viewport.worldToScreen({
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      })
      // placeRotateHandle 工作在屏幕空间：半高必须先乘 zoom
      const halfHeight = (bounds.height * props.frame.viewport.zoom) / 2
      return placeRotateHandle(center, halfHeight, HANDLE_OFFSET, rotation)
    }

    /** 顶边中点到手柄圆心的引导线 */
    function renderGuideLine(placement: RotateHandlePlacement): ReturnType<typeof h> {
      return h(
        'svg',
        {
          key: 'line',
          class: 'lc-rotate-guide',
          style: {
            position: 'absolute',
            inset: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            overflow: 'visible',
          },
        },
        [
          h('line', {
            x1: placement.topMid.x,
            y1: placement.topMid.y,
            x2: placement.handle.x,
            y2: placement.handle.y,
            stroke: 'var(--lc-accent, #2563eb)',
            'stroke-opacity': 0.45,
            'stroke-width': 1,
          }),
        ],
      )
    }

    /** 可拖拽的圆形手柄本体；圆心压在 placement.handle 上，故左上角外退半个直径 */
    function renderHandleKnob(placement: RotateHandlePlacement): ReturnType<typeof h> {
      return h(
        'div',
        {
          key: 'handle',
          class: 'lc-rotate-handle',
          // 必须与 canvas-rotate 的 ROTATE_HANDLE_ID 一致：管线靠它进入 target 阶段，
          // 缩放插件也靠它排除本手柄
          'data-handle-id': 'rotate',
          title: '旋转选区（Shift 按 15° 步进）',
          style: {
            ...KNOB_STYLE,
            left: `${placement.handle.x - HANDLE_SIZE / 2}px`,
            top: `${placement.handle.y - HANDLE_SIZE / 2}px`,
          },
        },
        '↻',
      )
    }

    return () => {
      const placement = computePlacement()
      if (!placement) return null

      return h(
        'div',
        {
          class: 'lc-rotate-layer',
          style: { position: 'absolute', inset: '0', pointerEvents: 'none' },
        },
        [renderGuideLine(placement), renderHandleKnob(placement)],
      )
    }
  },
})

export default RotateHandle
