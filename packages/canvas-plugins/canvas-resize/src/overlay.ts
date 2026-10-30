import { defineComponent, h } from 'vue'
import type { PropType } from 'vue'
import type { CanvasFrame, CanvasService, DocumentService } from '@lc/contracts'
import { useAppContext } from '@lc/vue'

interface HandleDef {
  /** 手柄方位 id，写入 data-handle-id 供交互管线命中 */
  id: string
  /** 相对选中框的横向比例 0~1 */
  x: number
  /** 相对选中框的纵向比例 0~1 */
  y: number
  /** 光标样式 */
  cursor: string
}

/** 八向手柄；顺序用于渲染层级，命中按 data-handle-id 区分 */
const HANDLES: HandleDef[] = [
  { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
  { id: 'n', x: 0.5, y: 0, cursor: 'ns-resize' },
  { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'e', x: 1, y: 0.5, cursor: 'ew-resize' },
  { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
  { id: 's', x: 0.5, y: 1, cursor: 'ns-resize' },
  { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
  { id: 'w', x: 0, y: 0.5, cursor: 'ew-resize' },
]

/** 手柄边长（屏幕像素）：固定大小，不随 zoom 变粗 */
const HANDLE_SIZE = 8

/**
 * 缩放手柄覆盖层。
 *
 * - 单选：手柄框跟随节点旋转（绕矩形中心旋转，与节点渲染一致）
 * - 多选：手柄围绕选中集包围盒绘制，组框保持轴对齐
 * 手柄在屏幕空间定位、尺寸固定，不随 zoom 变粗。
 */
export const ResizeHandles = defineComponent({
  name: 'LcResizeHandles',
  props: {
    /** 画布帧快照 */
    frame: { type: Object as PropType<CanvasFrame>, required: true },
  },
  setup(props) {
    const ctx = useAppContext()
    const canvas = ctx.require<CanvasService>('canvas')
    const document = ctx.require<DocumentService>('document')

    return () => {
      const selection = props.frame.selection
      if (selection.length === 0) return null

      const singleId = selection.length === 1 ? (selection[0] as string) : null
      const bounds = singleId
        ? canvas.scene.getBounds(singleId)
        : canvas.scene.getBoundsOf(selection)
      if (!bounds) return null

      const rotationDeg = singleId
        ? (document.model.schema.nodes[singleId]?.layout?.rotate ?? 0)
        : 0

      const { zoom } = props.frame.viewport
      // 手写投影只应用了 zoom 与 origin，与选择覆盖层同样假设视口无旋转；
      // 下面的 transform rotate 是节点自身角度，不是视口旋转
      const left = (bounds.x - props.frame.viewport.x) * zoom
      const top = (bounds.y - props.frame.viewport.y) * zoom
      const width = bounds.width * zoom
      const height = bounds.height * zoom

      const frame = h(
        'div',
        {
          class: 'lc-resize-handles',
          style: {
            position: 'absolute',
            left: `${left}px`,
            top: `${top}px`,
            width: `${width}px`,
            height: `${height}px`,
            transform: rotationDeg ? `rotate(${rotationDeg}deg)` : undefined,
            transformOrigin: 'center',
            pointerEvents: 'none',
          },
        },
        HANDLES.map((handle) =>
          h('div', {
            key: handle.id,
            class: 'lc-resize-handle',
            'data-handle-id': handle.id,
            style: {
              position: 'absolute',
              left: `${handle.x * width - HANDLE_SIZE / 2}px`,
              top: `${handle.y * height - HANDLE_SIZE / 2}px`,
              width: `${HANDLE_SIZE}px`,
              height: `${HANDLE_SIZE}px`,
              background: 'var(--lc-handle-bg, #ffffff)',
              border: '1px solid var(--lc-accent, #2563eb)',
              borderRadius: '2px',
              boxSizing: 'border-box',
              pointerEvents: 'auto',
              cursor: handle.cursor,
            },
          }),
        ),
      )

      return [
        frame,
        sizeBadge(bounds, left + width / 2, top + height + 10, selection.length > 1),
      ]
    }
  },
})

/**
 * 尺寸标注。
 *
 * 挂在框外下方而不是框内：手柄本身占着框边，标注压在框内会挡住缩放手柄的命中，
 * 也容易和节点内容混在一起。旋转节点的框是转过的，标注仍放在世界 AABB 下方，
 * 这是有意的——数值标注只表达尺寸，不该跟着转。
 */
function sizeBadge(
  bounds: { width: number; height: number },
  centerX: number,
  top: number,
  grouped: boolean,
): ReturnType<typeof h> {
  return h(
    'div',
    {
      class: 'lc-size-badge',
      style: {
        position: 'absolute',
        left: `${centerX}px`,
        top: `${top}px`,
        transform: 'translateX(-50%)',
        padding: '2px 6px',
        borderRadius: '4px',
        background: 'var(--lc-accent, #2563eb)',
        color: '#ffffff',
        fontSize: '11px',
        lineHeight: '14px',
        fontWeight: 500,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      },
    },
    `${grouped ? '组 ' : ''}${Math.round(bounds.width)} × ${Math.round(bounds.height)}`,
  )
}

export default ResizeHandles
