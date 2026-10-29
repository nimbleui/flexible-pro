import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import type { PropType } from 'vue'
import type { CanvasFrame, CanvasService } from '@lc/contracts'
import { useAppContext } from '@lc/vue'
import { GRID_SETTING } from './constants'

/** 网格点在屏幕上的最小间距；低于该值隐藏网格，避免摩尔纹 */
const MIN_SCREEN_STEP = 6

/**
 * 网格覆盖层。
 *
 * 用两层 CSS 线性渐变绘制，位置随视口 origin 取模对齐；
 * 只在屏幕空间计算，不给内容舞台叠加额外 transform。
 */
export const GridOverlay = defineComponent({
  name: 'LcGridOverlay',
  props: {
    /** 画布帧快照 */
    frame: { type: Object as PropType<CanvasFrame>, required: true },
  },
  setup(props) {
    const ctx = useAppContext()
    const canvas = ctx.require<CanvasService>('canvas')

    // 画布设置服务不是响应式源，用自增计数把它的变化桥接进 Vue 的依赖追踪
    const version = ref(0)

    onMounted(() => {
      // 订阅放在 onMounted：取消函数交给 onUnmounted，与组件生命周期严格对齐
      const off = canvas.settings.onDidChange(GRID_SETTING, () => {
        version.value += 1
      })
      onUnmounted(off.dispose)
    })

    return () => {
      // 单独读取一次是为了让 render 依赖 version，设置项变化时才会重绘
      version.value

      // 回退值与设置项 default 保持一致，未注册该设置时网格不应消失
      const step = canvas.settings.get<number>(GRID_SETTING) ?? 8
      const { zoom, x, y } = props.frame.viewport
      const screenStep = step * zoom
      if (screenStep < MIN_SCREEN_STEP) return null

      // 取模结果可能为负（x 为正方向时），补一个 screenStep 再取一次模，
      // 把偏移折回 [0, screenStep)，保证 backgroundPosition 与网格线始终对齐
      const offsetX = (((-x * zoom) % screenStep) + screenStep) % screenStep
      const offsetY = (((-y * zoom) % screenStep) + screenStep) % screenStep

      return h('div', {
        class: 'lc-grid',
        style: {
          position: 'absolute',
          inset: '0',
          pointerEvents: 'none',
          backgroundImage:
            'linear-gradient(to right, var(--lc-grid-line, rgba(15, 23, 42, 0.08)) 1px, transparent 1px),' +
            'linear-gradient(to bottom, var(--lc-grid-line, rgba(15, 23, 42, 0.08)) 1px, transparent 1px)',
          backgroundSize: `${screenStep}px ${screenStep}px`,
          backgroundPosition: `${offsetX}px ${offsetY}px`,
        },
      })
    }
  },
})

export default GridOverlay
