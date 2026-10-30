import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import type { PropType } from 'vue'
import type { CanvasFrame, CanvasService } from '@lc/contracts'
import { useAppContext } from '@lc/vue'
import {
  EMPTY_GUIDES,
  GUIDE_DRAFT_SETTING,
  USER_GUIDES_SETTING,
  guideHandleId,
  rulerStep,
} from './guides'
import type { GuideDraft, UserGuides } from './guides'

/** 标尺厚度（屏幕像素），左上角留同样大小的空白方块 */
const RULER = 20
/** 主刻度之间的细分格数 */
const MINOR = 5
/** 参考线手柄的命中厚度（屏幕像素），线本身只有 1px 抓不住 */
const GUIDE_HIT = 7

/** 一条刻度：屏幕位置 + 是否主刻度 */
interface Tick {
  at: number
  major: boolean
  label?: string
}

/**
 * 标尺与参考线覆盖层。
 *
 * 刻度按当前视口实时换算，标尺本身是 HTML 条 + 内部 SVG 刻度；参考线用带
 * `data-handle-id` 的细长条渲染，交互处理器靠这个 id 认领拖拽与双击删除。
 */
export const RulersOverlay = defineComponent({
  name: 'LcRulersOverlay',
  props: {
    /** 画布帧快照 */
    frame: { type: Object as PropType<CanvasFrame>, required: true },
  },
  setup(props) {
    const ctx = useAppContext()
    const canvas = ctx.require<CanvasService>('canvas')

    // 参考线与草稿都写在画布设置里，用自增计数桥接进 Vue 依赖
    const version = ref(0)
    const disposables: Array<{ dispose(): void }> = []

    const bump = (): void => {
      version.value += 1
    }

    onMounted(() => {
      disposables.push(canvas.settings.onDidChange(USER_GUIDES_SETTING, bump))
      disposables.push(canvas.settings.onDidChange(GUIDE_DRAFT_SETTING, bump))
    })

    onUnmounted(() => {
      for (const disposable of disposables) disposable.dispose()
      disposables.length = 0
    })

    /**
     * 世界坐标序列 → 屏幕刻度序列。
     *
     * `limit` 是该标尺条的屏幕长度，越界的刻度直接丢掉：SVG 里留几千个不可见的
     * line 会让每次平移都重画一遍。
     */
    function ticksOf(
      startWorld: number,
      endWorld: number,
      toScreen: (value: number) => number,
      limit: number,
    ): Tick[] {
      const step = rulerStep(props.frame.viewport.zoom)
      const minor = step / MINOR
      const ticks: Tick[] = []

      const first = Math.floor(startWorld / minor) * minor
      for (let value = first; value <= endWorld; value += minor) {
        const at = toScreen(value)
        if (at < -1 || at > limit + 1) continue
        const isMajor = Math.abs(value / step - Math.round(value / step)) < 1e-6
        ticks.push({ at, major: isMajor, label: isMajor ? formatTick(value) : undefined })
      }
      return ticks
    }

    return () => {
      version.value

      const guides = canvas.settings.get<UserGuides>(USER_GUIDES_SETTING) ?? EMPTY_GUIDES
      const draft = canvas.settings.get<GuideDraft | null>(GUIDE_DRAFT_SETTING) ?? null
      const { viewport, size } = props.frame
      const zoom = viewport.zoom

      const toScreenX = (world: number): number => (world - viewport.x) * zoom
      const toScreenY = (world: number): number => (world - viewport.y) * zoom
      const worldRight = viewport.x + size.width / zoom
      const worldBottom = viewport.y + size.height / zoom

      const xTicks = ticksOf(viewport.x, worldRight, toScreenX, size.width)
      const yTicks = ticksOf(viewport.y, worldBottom, toScreenY, size.height)

      return h(
        'div',
        {
          class: 'lc-rulers',
          style: { position: 'absolute', inset: '0', pointerEvents: 'none', fontSize: '10px' },
        },
        [
          ...guides.horizontal.map((value, index) => guideLine('h', toScreenY(value), index)),
          ...guides.vertical.map((value, index) => guideLine('v', toScreenX(value), index)),
          draft ? draftLine(draft, toScreenX, toScreenY, size) : null,
          rulerStrip('horizontal', size.width, xTicks),
          rulerStrip('vertical', size.height, yTicks),
          h('div', {
            key: 'corner',
            style: {
              position: 'absolute',
              left: '0',
              top: '0',
              width: `${RULER}px`,
              height: `${RULER}px`,
              background: 'var(--lc-surface, #fff)',
              borderRight: '1px solid var(--lc-border, rgba(15,23,42,.12))',
              borderBottom: '1px solid var(--lc-border, rgba(15,23,42,.12))',
              boxSizing: 'border-box',
            },
          }),
        ],
      )
    }
  },
})

/** 刻度文字：1e-6 容差去掉浮点尾巴，大数不带小数 */
function formatTick(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

function rulerStrip(
  axis: 'horizontal' | 'vertical',
  length: number,
  ticks: Tick[],
): ReturnType<typeof h> {
  const isRow = axis === 'horizontal'
  const style: Record<string, string> = isRow
    ? {
        position: 'absolute',
        left: `${RULER}px`,
        top: '0',
        width: `calc(100% - ${RULER}px)`,
        height: `${RULER}px`,
        cursor: 'ns-resize',
      }
    : {
        position: 'absolute',
        left: '0',
        top: `${RULER}px`,
        width: `${RULER}px`,
        height: `calc(100% - ${RULER}px)`,
        cursor: 'ew-resize',
      }

  return h(
    'div',
    {
      key: `ruler-${axis}`,
      'data-handle-id': isRow ? 'ruler-h' : 'ruler-v',
      style: {
        ...style,
        pointerEvents: 'auto',
        background: 'var(--lc-surface, #fff)',
        borderRight: isRow ? 'none' : '1px solid var(--lc-border, rgba(15,23,42,.12))',
        borderBottom: isRow ? '1px solid var(--lc-border, rgba(15,23,42,.12))' : 'none',
        boxSizing: 'border-box',
        overflow: 'hidden',
      },
    },
    h(
      'svg',
      {
        width: isRow ? length : RULER,
        height: isRow ? RULER : length,
        style: { display: 'block', pointerEvents: 'none' },
      },
      ticks.flatMap((tick, index) => {
        const line = h('line', {
          key: `t-${index}`,
          x1: isRow ? tick.at : 0,
          y1: isRow ? 0 : tick.at,
          x2: isRow ? tick.at : RULER,
          y2: isRow ? RULER : tick.at,
          stroke: 'var(--lc-border-strong, rgba(15,23,42,.28))',
          strokeWidth: 1,
        })
        if (!tick.major || tick.label === undefined) return [line]

        return [
          line,
          h(
            'text',
            {
              key: `l-${index}`,
              x: isRow ? tick.at + 3 : 2,
              y: isRow ? RULER - 6 : tick.at - 4,
              fill: 'var(--lc-text-secondary, #64748b)',
              fontSize: 9,
            },
            tick.label,
          ),
        ]
      }),
    ),
  )
}

function guideLine(axis: 'h' | 'v', at: number, index: number): ReturnType<typeof h> {
  const isRow = axis === 'h'
  return h(
    'div',
    {
      key: `guide-${axis}-${index}`,
      'data-handle-id': guideHandleId(isRow ? 'horizontal' : 'vertical', index),
      style: {
        position: 'absolute',
        left: isRow ? '0' : `${at - GUIDE_HIT / 2}px`,
        top: isRow ? `${at - GUIDE_HIT / 2}px` : '0',
        width: isRow ? '100%' : `${GUIDE_HIT}px`,
        height: isRow ? `${GUIDE_HIT}px` : '100%',
        pointerEvents: 'auto',
        cursor: isRow ? 'ns-resize' : 'ew-resize',
      },
    },
    h('div', {
      style: {
        position: 'absolute',
        left: isRow ? '0' : `${GUIDE_HIT / 2 - 0.5}px`,
        top: isRow ? `${GUIDE_HIT / 2 - 0.5}px` : '0',
        width: isRow ? '100%' : '1px',
        height: isRow ? '1px' : '100%',
        background: 'var(--lc-guide, #22d3ee)',
      },
    }),
  )
}

function draftLine(
  draft: GuideDraft,
  toScreenX: (value: number) => number,
  toScreenY: (value: number) => number,
  size: { width: number; height: number },
): ReturnType<typeof h> {
  const isRow = draft.axis === 'horizontal'
  const at = isRow ? toScreenY(draft.value) : toScreenX(draft.value)

  return h('div', {
    key: 'guide-draft',
    style: {
      position: 'absolute',
      left: isRow ? '0' : `${at}px`,
      top: isRow ? `${at}px` : '0',
      width: isRow ? `${size.width}px` : '1px',
      height: isRow ? '1px' : `${size.height}px`,
      background: 'var(--lc-guide, #22d3ee)',
      opacity: 0.85,
    },
  })
}

export default RulersOverlay
