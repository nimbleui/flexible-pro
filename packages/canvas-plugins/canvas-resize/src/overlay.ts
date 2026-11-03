import { defineComponent, h } from 'vue'
import type { CSSProperties, PropType } from 'vue'
import type { CanvasFrame, CanvasService, DocumentService, Size } from '@lc/contracts'
import type { Rect } from '@lc/schema'
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
 * 手柄框的屏幕几何。
 *
 * 由选中集的世界矩形投影而来，覆盖层只消费这份结果，不再各自读视口。
 */
interface HandleBox {
  /** 选中框左上角相对舞台的横向偏移（屏幕 CSS 像素 = 世界 x 减视口 x 后乘 zoom） */
  left: number
  /** 选中框左上角相对舞台的纵向偏移（同上，不含设备像素比） */
  top: number
  /** 选中框屏幕宽（世界宽 × zoom） */
  width: number
  /** 选中框屏幕高（世界高 × zoom） */
  height: number

  /** 节点自身旋转角度（度）；多选恒为 0，组框不跟随旋转 */
  rotationDeg: number
  /** 未旋转的世界包围盒；尺寸标注直接读它，不做 zoom 换算 */
  bounds: Rect
  /** 是否多选（组缩放）：只影响标注文案前缀 */
  grouped: boolean
}

/**
 * 求当前选区的手柄框。
 *
 * 无选中、或包围盒缺失（节点已删除等瞬态）时返回 null，覆盖层整体不渲染。
 * 投影只应用 zoom 与视口原点，与选择覆盖层同样假设视口无旋转；
 * `rotationDeg` 是节点自身角度，不参与这一步换算。
 */
function resolveHandleBox(
  frame: CanvasFrame,
  canvas: CanvasService,
  document: DocumentService,
): HandleBox | null {
  const selection = frame.selection
  if (selection.length === 0) return null

  const singleId = selection.length === 1 ? (selection[0] as string) : null
  const bounds = singleId
    ? canvas.scene.getBounds(singleId)
    : canvas.scene.getBoundsOf(selection)
  if (!bounds) return null

  const { zoom, x: originX, y: originY } = frame.viewport
  return {
    left: (bounds.x - originX) * zoom,
    top: (bounds.y - originY) * zoom,
    width: bounds.width * zoom,
    height: bounds.height * zoom,
    rotationDeg: singleId ? (document.model.schema.nodes[singleId]?.layout?.rotate ?? 0) : 0,
    bounds,
    grouped: selection.length > 1,
  }
}

/** 手柄框容器：整体绕中心旋转，八个手柄按选中框比例落位 */
function renderHandleFrame(box: HandleBox): ReturnType<typeof h> {
  return h(
    'div',
    {
      class: 'lc-resize-handles',
      style: {
        position: 'absolute',
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        transform: box.rotationDeg ? `rotate(${box.rotationDeg}deg)` : undefined,
        transformOrigin: 'center',
        pointerEvents: 'none',
      },
    },
    HANDLES.map((handle) => renderHandleBox(handle, box.width, box.height)),
  )
}

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
      const box = resolveHandleBox(props.frame, canvas, document)
      if (!box) return null

      return [
        renderHandleFrame(box),
        sizeBadge(box.bounds, box.left + box.width / 2, box.top + box.height + 10, box.grouped),
      ]
    }
  },
})

/**
 * 单个缩放手柄。
 *
 * 位置按选中框比例落位（0/0.5/1），再外扩半个手柄让中心压住框点；
 * 尺寸用固定屏幕像素，不随 zoom 变化。
 */
function renderHandleBox(handle: HandleDef, boxWidth: number, boxHeight: number) {
  return h('div', {
    key: handle.id,
    class: 'lc-resize-handle',
    'data-handle-id': handle.id,
    style: {
      position: 'absolute',
      left: `${handle.x * boxWidth - HANDLE_SIZE / 2}px`,
      top: `${handle.y * boxHeight - HANDLE_SIZE / 2}px`,
      width: `${HANDLE_SIZE}px`,
      height: `${HANDLE_SIZE}px`,
      background: 'var(--lc-handle-bg, #ffffff)',
      border: '1px solid var(--lc-accent, #2563eb)',
      borderRadius: '2px',
      boxSizing: 'border-box',
      pointerEvents: 'auto',
      cursor: handle.cursor,
    },
  })
}

/** 标注外观：除落点以外全部固定，提到模块级避免每帧重建同构字面量 */
const SIZE_BADGE_STYLE: CSSProperties = {
  position: 'absolute',
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
}

/**
 * 尺寸标注。
 *
 * 挂在框外下方而不是框内：手柄本身占着框边，标注压在框内会挡住缩放手柄的命中，
 * 也容易和节点内容混在一起。旋转节点的框是转过的，标注仍放在世界 AABB 下方，
 * 这是有意的——数值标注只表达尺寸，不该跟着转。
 *
 * @param bounds 选中集未旋转 AABB 的世界尺寸（世界单位）；标注直接显示数值，不做 zoom 换算
 * @param centerX 标注水平中心相对舞台的横向偏移（屏幕 CSS 像素），配合 translateX(-50%) 居中
 * @param top 标注顶边相对舞台的纵向偏移（屏幕 CSS 像素）
 */
function sizeBadge(
  bounds: Size,
  centerX: number,
  top: number,
  grouped: boolean,
): ReturnType<typeof h> {
  return h(
    'div',
    {
      class: 'lc-size-badge',
      style: { ...SIZE_BADGE_STYLE, left: `${centerX}px`, top: `${top}px` },
    },
    `${grouped ? '组 ' : ''}${Math.round(bounds.width)} × ${Math.round(bounds.height)}`,
  )
}

export default ResizeHandles
