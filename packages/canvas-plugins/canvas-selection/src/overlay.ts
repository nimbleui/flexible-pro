import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import type { PropType } from 'vue'
import type { CanvasFrame, CanvasService, DocumentService } from '@lc/contracts'
import type { Rect } from '@lc/schema'
import { useAppContext } from '@lc/vue'
import { MARQUEE_SETTING } from './constants'

/** 世界矩形 → 屏幕矩形（骨架阶段假设视口无旋转） */
function toScreenRect(frame: CanvasFrame, rect: Rect): Rect {
  const scale = frame.viewport.zoom
  return {
    x: (rect.x - frame.viewport.x) * scale,
    y: (rect.y - frame.viewport.y) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  }
}

/**
 * 选择覆盖层：选中描边 + 框选矩形。
 *
 * - 选中集来自 `frame.selection`（LayerHost 在 selection 变化时刷新）
 * - 节点描边按自身 `layout.rotate` 旋转，跟随节点而不是显示 AABB
 * - 框选矩形来自画布设置 `MARQUEE_SETTING`（手势期间的临时值）
 */
export const SelectionOverlay = defineComponent({
  name: 'LcSelectionOverlay',
  props: {
    /** 画布帧快照 */
    frame: { type: Object as PropType<CanvasFrame>, required: true },
  },
  setup(props) {
    const ctx = useAppContext()
    const canvas = ctx.require<CanvasService>('canvas')
    const document = ctx.require<DocumentService>('document')

    // 框选矩形写在画布设置里而不是响应式状态，用自增计数把它桥接进 Vue 依赖追踪
    const version = ref(0)

    onMounted(() => {
      // 订阅与取消都挂在组件生命周期上，避免手势结束后仍持有回调
      const off = canvas.settings.onDidChange(MARQUEE_SETTING, () => {
        version.value += 1
      })
      onUnmounted(off.dispose)
    })

    return () => {
      // 单独读取一次建立渲染依赖，否则设置变化不会触发重绘
      version.value

      const outlines = props.frame.selection
        .map((id) => {
          const rect = canvas.scene.getBounds(id)
          if (!rect) return null
          return {
            id,
            rect: toScreenRect(props.frame, rect),
            rotate: document.model.schema.nodes[id]?.layout?.rotate ?? 0,
          }
        })
        .filter((item): item is { id: string; rect: Rect; rotate: number } => item !== null)

      const marquee = canvas.settings.get<Rect | null>(MARQUEE_SETTING)

      const children = outlines.map(({ id, rect, rotate }) =>
        h('div', {
          key: id,
          class: 'lc-selection-outline',
          'data-selection-id': id,
          style: {
            position: 'absolute',
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            transform: rotate ? `rotate(${rotate}deg)` : undefined,
            transformOrigin: 'center',
            border: '1px solid var(--lc-accent, #2563eb)',
            boxSizing: 'border-box',
            pointerEvents: 'none',
          },
        }),
      )

      if (marquee) {
        const screen = toScreenRect(props.frame, marquee)
        children.push(
          h('div', {
            class: 'lc-marquee',
            style: {
              position: 'absolute',
              left: `${screen.x}px`,
              top: `${screen.y}px`,
              width: `${screen.width}px`,
              height: `${screen.height}px`,
              border: '1px dashed var(--lc-accent, #2563eb)',
              background: 'rgba(37, 99, 235, 0.08)',
              boxSizing: 'border-box',
              pointerEvents: 'none',
            },
          }),
        )
      }

      return h(
        'div',
        { class: 'lc-selection-overlay', style: { position: 'absolute', inset: '0' } },
        children,
      )
    }
  },
})

export default SelectionOverlay
