import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import type { PropType } from 'vue'
import type { CanvasFrame, CanvasService, MaterialService } from '@lc/contracts'
import type { Rect } from '@lc/schema'
import { useAppContext } from '@lc/vue'
import { DEFAULT_DROP_HEIGHT, DEFAULT_DROP_WIDTH, DROP_PREVIEW_SETTING } from './constants'
import type { DropPreview } from './constants'

/**
 * 拖入预览覆盖层。
 *
 * 显示物料默认尺寸的幽灵框与目标容器高亮；全部在屏幕空间绘制，
 * 不写文档、不创建历史。
 */
export const DropOverlay = defineComponent({
  name: 'LcDropOverlay',
  props: {
    /** 画布帧快照 */
    frame: { type: Object as PropType<CanvasFrame>, required: true },
  },
  setup(props) {
    const ctx = useAppContext()
    const canvas = ctx.require<CanvasService>('canvas')
    const material = ctx.require<MaterialService>('material')
    const version = ref(0)

    onMounted(() => {
      const off = canvas.settings.onDidChange(DROP_PREVIEW_SETTING, () => {
        version.value += 1
      })
      onUnmounted(off.dispose)
    })

    /**
     * 世界矩形 → 屏幕矩形。
     *
     * 公式与视口服务的 `worldToScreen` 一致，但读的是 frame 快照而非实时服务：
     * 预览必须和同帧画出来的场景对齐，读活视口会在提交瞬间错位。
     */
    function toScreen(rect: Rect): Rect {
      const { zoom, x, y } = props.frame.viewport
      return {
        x: (rect.x - x) * zoom,
        y: (rect.y - y) * zoom,
        width: rect.width * zoom,
        height: rect.height * zoom,
      }
    }

    /** 幽灵框矩形（屏幕空间）：以落点世界坐标为中心，尺寸取物料 snippet 默认宽高 */
    function computeGhostRect(preview: DropPreview): Rect {
      const entry = material.get(preview.materialName)
      const snippetRect = entry?.snippet?.layout?.rect
      const size = {
        width: snippetRect?.width ?? DEFAULT_DROP_WIDTH,
        height: snippetRect?.height ?? DEFAULT_DROP_HEIGHT,
      }
      const ghost = toScreen({
        x: preview.world.x - size.width / 2,
        y: preview.world.y - size.height / 2,
        width: size.width,
        height: size.height,
      })
      return ghost
    }

    /** 绘制物料落点幽灵框 */
    function ghostBox(ghost: Rect): ReturnType<typeof h> {
      return h('div', {
        key: 'ghost',
        class: 'lc-drop-ghost',
        style: {
          position: 'absolute',
          left: `${ghost.x}px`,
          top: `${ghost.y}px`,
          width: `${ghost.width}px`,
          height: `${ghost.height}px`,
          border: '1px dashed var(--lc-accent, #2563eb)',
          background: 'rgba(37, 99, 235, 0.10)',
          borderRadius: '4px',
          boxSizing: 'border-box',
          pointerEvents: 'none',
        },
      })
    }

    /** 命中容器时的外沿高亮框 */
    function containerHighlight(containerScreen: Rect): ReturnType<typeof h> {
      return h('div', {
        key: 'container',
        class: 'lc-drop-container',
        style: {
          position: 'absolute',
          left: `${containerScreen.x}px`,
          top: `${containerScreen.y}px`,
          width: `${containerScreen.width}px`,
          height: `${containerScreen.height}px`,
          outline: '1px solid var(--lc-accent, #2563eb)',
          outlineOffset: '2px',
          pointerEvents: 'none',
        },
      })
    }

    return () => {
      version.value
      const preview = canvas.settings.get<DropPreview | null>(DROP_PREVIEW_SETTING)
      if (!preview) return null

      const containerRect = preview.containerId
        ? canvas.scene.getBounds(preview.containerId)
        : undefined
      const containerScreen = containerRect ? toScreen(containerRect) : null

      const children = [ghostBox(computeGhostRect(preview))]
      if (containerScreen) children.push(containerHighlight(containerScreen))

      return h(
        'div',
        { class: 'lc-drop-overlay', style: { position: 'absolute', inset: '0' } },
        children,
      )
    }
  },
})

export default DropOverlay
