import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import type { PropType } from 'vue'
import type { CanvasFrame, CanvasService, DocumentService } from '@lc/contracts'
import type { Rect } from '@lc/schema'
import { useAppContext } from '@lc/vue'
import { HOVER_SETTING, MARQUEE_SETTING } from './constants'

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
 * 选择覆盖层：悬停高亮 + 选中描边 + 框选矩形。
 *
 * - 选中集来自 `frame.selection`（LayerHost 在 selection 变化时刷新）
 * - 节点描边按自身 `layout.rotate` 旋转，跟随节点而不是显示 AABB
 * - 悬停高亮来自 `HOVER_SETTING`，只画在未选中的节点上，避免同处出现两套框
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

    // 悬停与框选都写在画布设置里而不是响应式状态，用自增计数把它们桥接进 Vue 依赖追踪
    const version = ref(0)

    onMounted(() => {
      // 订阅与取消都挂在组件生命周期上，避免手势结束后仍持有回调
      const offs = [MARQUEE_SETTING, HOVER_SETTING].map((id) =>
        canvas.settings.onDidChange(id, () => {
          version.value += 1
        }),
      )
      onUnmounted(() => {
        for (const off of offs) off.dispose()
      })
    })

    return () => {
      // 单独读取一次建立渲染依赖，否则设置变化不会触发重绘
      version.value

      const marquee = canvas.settings.get<Rect | null>(MARQUEE_SETTING)
      const hovered = canvas.settings.get<string | null>(HOVER_SETTING)

      /** 取节点的屏幕矩形与自身旋转；没有几何（隐藏/未同步）时返回 null */
      function outlineOf(id: string): NodeOutline | null {
        const rect = canvas.scene.getBounds(id)
        if (!rect) return null
        return {
          id,
          rect: toScreenRect(props.frame, rect),
          rotate: document.model.schema.nodes[id]?.layout?.rotate ?? 0,
        }
      }

      const outlines = props.frame.selection
        .map((id) => outlineOf(id))
        .filter((item): item is NodeOutline => item !== null)

      // 悬停框只画在未选中的节点上，避免同处出现两套框
      const hoverOutline =
        hovered && !props.frame.selection.includes(hovered) ? outlineOf(hovered) : null

      const children: ReturnType<typeof h>[] = []

      if (hoverOutline) children.push(renderHoverBox(hoverOutline))
      children.push(...outlines.map(renderSelectionBox))
      if (marquee) children.push(renderMarqueeBox(toScreenRect(props.frame, marquee)))

      return h(
        'div',
        { class: 'lc-selection-overlay', style: { position: 'absolute', inset: '0' } },
        children,
      )
    }
  },
})

/** 一个节点在覆盖层里的绘制输入：屏幕矩形 + 节点自身角度 */
interface NodeOutline {
  /** 节点 id，作为列表 key 与 data-selection-id 供命中回查 */
  id: string
  /** 已换算到屏幕空间的矩形（CSS 像素，相对舞台原点） */
  rect: Rect
  /** 节点 layout.rotate，度数；0 时不写 transform，避免多余合成层 */
  rotate: number
}

/** 悬停虚线框：与选中框同样的几何，但永不接管指针 */
function renderHoverBox(outline: NodeOutline): ReturnType<typeof h> {
  return h('div', {
    key: 'hover',
    class: 'lc-hover-outline',
    style: {
      position: 'absolute',
      left: `${outline.rect.x}px`,
      top: `${outline.rect.y}px`,
      width: `${outline.rect.width}px`,
      height: `${outline.rect.height}px`,
      transform: outline.rotate ? `rotate(${outline.rotate}deg)` : undefined,
      transformOrigin: 'center',
      border: '1px dashed var(--lc-accent, #2f8cff)',
      boxShadow: '0 0 8px var(--lc-glow-soft, rgba(47,140,255,0.25))',
      boxSizing: 'border-box',
      pointerEvents: 'none',
    },
  })
}

/** 选中节点的实线描边 */
function renderSelectionBox(outline: NodeOutline): ReturnType<typeof h> {
  return h('div', {
    key: outline.id,
    class: 'lc-selection-outline',
    'data-selection-id': outline.id,
    style: {
      position: 'absolute',
      left: `${outline.rect.x}px`,
      top: `${outline.rect.y}px`,
      width: `${outline.rect.width}px`,
      height: `${outline.rect.height}px`,
      transform: outline.rotate ? `rotate(${outline.rotate}deg)` : undefined,
      transformOrigin: 'center',
      border: '1px solid var(--lc-accent, #2f8cff)',
      boxShadow:
        '0 0 0 1px var(--lc-glow-soft, rgba(47,140,255,0.25)), 0 0 14px var(--lc-glow, rgba(47,140,255,0.45))',
      boxSizing: 'border-box',
      pointerEvents: 'none',
    },
  })
}

/** 框选过程中的临时矩形 */
function renderMarqueeBox(screen: Rect): ReturnType<typeof h> {
  return h('div', {
    class: 'lc-marquee',
    style: {
      position: 'absolute',
      left: `${screen.x}px`,
      top: `${screen.y}px`,
      width: `${screen.width}px`,
      height: `${screen.height}px`,
      border: '1px dashed var(--lc-accent, #2f8cff)',
      background: 'var(--lc-accent-soft, rgba(47,140,255,0.14))',
      boxShadow: '0 0 12px var(--lc-glow-soft, rgba(47,140,255,0.2))',
      boxSizing: 'border-box',
      pointerEvents: 'none',
    },
  })
}

export default SelectionOverlay
