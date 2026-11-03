import { defineComponent, h } from 'vue'
import type { CSSProperties, PropType } from 'vue'
import type { CanvasFrame, CanvasService } from '@lc/contracts'
import { useAppContext } from '@lc/vue'
import {
  MINIMAP_HEADER,
  MINIMAP_SIZE,
  layoutFor,
  mapOrigin,
  toMapRect,
  viewportWorldRect,
} from './geometry'

/** 地图内容区里的一个矩形块（节点或视口框），由 toMapRect 产出 */
type MapRect = ReturnType<typeof toMapRect>

/**
 * 小地图外壳外观：整体尺寸固定为屏幕 CSS 像素（地图内容区 + 顶部标题条），
 * 只有落点按舞台右下角实时定位，不随 zoom 缩放。
 */
const MINIMAP_SHELL_STYLE: CSSProperties = {
  position: 'absolute',
  width: `${MINIMAP_SIZE.width}px`,
  height: `${MINIMAP_SIZE.height + MINIMAP_HEADER}px`,
  // 图层整体是 children 模式，只有这块实体接管指针
  pointerEvents: 'auto',
  boxSizing: 'border-box',
  border: '1px solid var(--lc-border, rgba(15,23,42,.12))',
  borderRadius: '8px',
  background: 'var(--lc-surface, #fff)',
  boxShadow: 'var(--lc-shadow, 0 8px 24px rgba(15,23,42,.12))',
  overflow: 'hidden',
  cursor: 'move',
}

/**
 * 小地图覆盖层。
 *
 * 内容 = 文档根包围盒 ∪ 当前可见世界矩形，所以视口框永远落在地图里；
 * 节点矩形直接取自场景（layout.rect），不读 DOM，缩放平移期间每帧重算的只是一次
 * 列表遍历。点击/拖动地图移动视口的手势在插件里注册，这里只负责画。
 */
export const MinimapOverlay = defineComponent({
  name: 'LcMinimapOverlay',
  props: {
    /** 画布帧快照 */
    frame: { type: Object as PropType<CanvasFrame>, required: true },
  },
  setup(props) {
    const ctx = useAppContext()
    const canvas = ctx.require<CanvasService>('canvas')

    /** 顶部标题条：显示当前缩放百分比 */
    function renderHeader(frame: CanvasFrame): ReturnType<typeof h> {
      return h(
        'div',
        {
          style: {
            height: `${MINIMAP_HEADER}px`,
            display: 'flex',
            alignItems: 'center',
            padding: '0 8px',
            fontSize: '10px',
            color: 'var(--lc-text-secondary, #64748b)',
            borderBottom: '1px solid var(--lc-border, rgba(15,23,42,.08))',
          },
        },
        `小地图 · ${Math.round(frame.viewport.zoom * 100)}%`,
      )
    }

    /** 单个节点矩形；key 用序号，因为 list() 顺序即渲染顺序且无稳定 id 传入 */
    function renderNodeBlock(rect: MapRect, index: number): ReturnType<typeof h> {
      return h('div', {
        key: `n-${index}`,
        style: {
          position: 'absolute',
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          background: 'rgba(37, 99, 235, 0.18)',
          borderRadius: '1px',
        },
      })
    }

    /** 视口框：标记当前舞台对应的世界范围 */
    function renderViewportBlock(rect: MapRect): ReturnType<typeof h> {
      return h('div', {
        key: 'viewport',
        style: {
          position: 'absolute',
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          boxSizing: 'border-box',
          border: '1.5px solid var(--lc-accent, #2563eb)',
          background: 'rgba(37, 99, 235, 0.06)',
        },
      })
    }

    /** 地图内容区：节点块 + 视口框，全部相对内容区绝对定位 */
    function renderMapBody(nodes: MapRect[], viewRect: MapRect): ReturnType<typeof h> {
      return h(
        'div',
        {
          style: {
            position: 'relative',
            width: `${MINIMAP_SIZE.width}px`,
            height: `${MINIMAP_SIZE.height}px`,
          },
        },
        [...nodes.map(renderNodeBlock), renderViewportBlock(viewRect)],
      )
    }

    return () => {
      const { frame } = props
      const origin = mapOrigin(frame.size)
      const visible = viewportWorldRect(frame.viewport, frame.size)
      const layout = layoutFor(canvas.scene.getRootBounds(), frame.viewport, frame.size)

      const nodes = canvas.scene
        .list()
        .map((nodeId) => toMapRect(layout, canvas.scene.getBounds(nodeId) ?? visible))

      return h(
        'div',
        {
          key: 'minimap',
          'data-handle-id': 'minimap',
          class: 'lc-minimap',
          style: {
            ...MINIMAP_SHELL_STYLE,
            left: `${origin.x}px`,
            top: `${origin.y - MINIMAP_HEADER}px`,
          },
        },
        [renderHeader(frame), renderMapBody(nodes, toMapRect(layout, visible))],
      )
    }
  },
})

export default MinimapOverlay
