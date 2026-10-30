import { defineComponent, h } from 'vue'
import type { PropType } from 'vue'
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

    return () => {
      const { frame } = props
      const origin = mapOrigin(frame.size)
      const visible = viewportWorldRect(frame.viewport, frame.size)
      const layout = layoutFor(canvas.scene.getRootBounds(), frame.viewport, frame.size)

      const nodes = canvas.scene
        .list()
        .map((nodeId) => toMapRect(layout, canvas.scene.getBounds(nodeId) ?? visible))
      const viewRect = toMapRect(layout, visible)

      return h(
        'div',
        {
          key: 'minimap',
          'data-handle-id': 'minimap',
          class: 'lc-minimap',
          style: {
            position: 'absolute',
            left: `${origin.x}px`,
            top: `${origin.y - MINIMAP_HEADER}px`,
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
          },
        },
        [
          h(
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
          ),
          h(
            'div',
            {
              style: {
                position: 'relative',
                width: `${MINIMAP_SIZE.width}px`,
                height: `${MINIMAP_SIZE.height}px`,
              },
            },
            [
              ...nodes.map((rect, index) =>
                h('div', {
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
                }),
              ),
              h('div', {
                key: 'viewport',
                style: {
                  position: 'absolute',
                  left: `${viewRect.left}px`,
                  top: `${viewRect.top}px`,
                  width: `${viewRect.width}px`,
                  height: `${viewRect.height}px`,
                  boxSizing: 'border-box',
                  border: '1.5px solid var(--lc-accent, #2563eb)',
                  background: 'rgba(37, 99, 235, 0.06)',
                },
              }),
            ],
          ),
        ],
      )
    }
  },
})

export default MinimapOverlay
