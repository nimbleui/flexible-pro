import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import type { PropType } from 'vue'
import type { CanvasFrame, CanvasService } from '@lc/contracts'
import type { Rect } from '@lc/schema'
import { useAppContext } from '@lc/vue'
import { DRAG_BADGE_SETTING } from './constants'

/**
 * 拖拽位置标注。
 *
 * 只在手势期间显示：位置值来自被拖节点的世界矩形，覆盖层负责把它投影回屏幕。
 * 标注贴在节点左上角外侧，拖动时不会盖住节点本身，也不会挡住吸附辅助线。
 */
export const DragBadgeOverlay = defineComponent({
  name: 'LcDragBadgeOverlay',
  props: {
    /** 画布帧快照 */
    frame: { type: Object as PropType<CanvasFrame>, required: true },
  },
  setup(props) {
    const ctx = useAppContext()
    const canvas = ctx.require<CanvasService>('canvas')

    const version = ref(0)
    const disposables: Array<{
      /** 退订画布设置监听，组件卸载时统一释放 */
      dispose(): void
    }> = []

    onMounted(() => {
      disposables.push(
        canvas.settings.onDidChange(DRAG_BADGE_SETTING, () => {
          version.value += 1
        }),
      )
    })

    onUnmounted(() => {
      for (const disposable of disposables) disposable.dispose()
      disposables.length = 0
    })

    return () => {
      version.value

      const rect = canvas.settings.get<Rect | null>(DRAG_BADGE_SETTING)
      if (!rect) return null

      const { zoom, x, y } = props.frame.viewport
      return badgeChip(rect, (rect.x - x) * zoom, (rect.y - y) * zoom)
    }
  },
})

/**
 * 标注本体。
 *
 * 左上角外侧锚定（top 再上提 6px 配 translateY(-100%)），既避开节点也
 * 避开吸附辅助线；显示的数值取世界矩形原点并四舍五入到整像素。
 */
function badgeChip(rect: Rect, left: number, top: number): ReturnType<typeof h> {
  return h(
    'div',
    {
      class: 'lc-drag-badge',
      style: {
        position: 'absolute',
        left: `${left}px`,
        top: `${top - 6}px`,
        transform: 'translateY(-100%)',
        padding: '2px 6px',
        borderRadius: '4px',
        background: 'rgba(15, 23, 42, 0.86)',
        color: '#ffffff',
        fontSize: '11px',
        lineHeight: '14px',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      },
    },
    `${Math.round(rect.x)}, ${Math.round(rect.y)}`,
  )
}

export default DragBadgeOverlay
