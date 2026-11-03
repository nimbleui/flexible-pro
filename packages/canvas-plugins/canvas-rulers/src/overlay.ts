import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import type { CSSProperties, PropType } from 'vue'
import type { CanvasFrame, CanvasService, Size } from '@lc/contracts'
import { useAppContext } from '@lc/vue'
import {
  EMPTY_GUIDES,
  GUIDE_DRAFT_SETTING,
  USER_GUIDES_SETTING,
  guideHandleId,
  rulerTicks,
} from './guides'
import type { GuideDraft, RulerTick, UserGuides } from './guides'

/** 标尺厚度（屏幕像素），左上角留同样大小的空白方块 */
const RULER = 20
/** 参考线手柄的命中厚度（屏幕像素），线本身只有 1px 抓不住 */
const GUIDE_HIT = 7

/**
 * 两轴刻度集合。
 *
 * 两组位置都在标尺条自身的局部屏幕像素空间（起点已让出拐角），与参考线用的
 * 舞台坐标差一个 `RULER` 厚度，两套原点不能混用。
 */
interface AxisTicks {
  /** 横向标尺（贴舞台顶边）的刻度 */
  x: RulerTick[]
  /** 纵向标尺（贴舞台左边）的刻度 */
  y: RulerTick[]
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
    const disposables: Array<{
      /** 退订画布设置监听，组件卸载时统一释放 */
      dispose(): void
    }> = []

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
     * 生成两轴刻度。
     *
     * 刻度位置在标尺条自身的坐标空间（起点已被拐角让出 RULER），而参考线用的
     * toScreen* 是舞台坐标——两套原点不能混用，否则整条刻度偏一个拐角厚度。
     */
    function buildTicks(): {
      /** 横向标尺（贴舞台顶边）的刻度；位置在该条自身的局部屏幕像素空间内 */
      x: RulerTick[]
      /** 纵向标尺（贴舞台左边）的刻度；同样是条内局部像素，与舞台坐标差一个拐角厚度 */
      y: RulerTick[]
    } {
      const { viewport, size } = props.frame
      const zoom = viewport.zoom
      return {
        x: rulerTicks({
          originWorld: viewport.x,
          zoom,
          inset: RULER,
          stageLength: size.width,
        }),
        y: rulerTicks({
          originWorld: viewport.y,
          zoom,
          inset: RULER,
          stageLength: size.height,
        }),
      }
    }

    return () => {
      version.value

      const guides = canvas.settings.get<UserGuides>(USER_GUIDES_SETTING) ?? EMPTY_GUIDES
      const draft = canvas.settings.get<GuideDraft | null>(GUIDE_DRAFT_SETTING) ?? null
      const { viewport, size } = props.frame
      const zoom = viewport.zoom

      const toScreenX = (world: number): number => (world - viewport.x) * zoom
      const toScreenY = (world: number): number => (world - viewport.y) * zoom

      const ticks = buildTicks()

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
          rulerStrip('horizontal', size.width - RULER, ticks.x),
          rulerStrip('vertical', size.height - RULER, ticks.y),
          cornerSquare(),
        ],
      )
    }
  },
})

/** 左上角拐角空白方块：压住两条标尺的起点交接处 */
function cornerSquare(): ReturnType<typeof h> {
  return h('div', {
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
  })
}

/**
 * 一条标尺：`length` 是刻度可用长度（舞台长度减去拐角），刻度位置已是条内局部坐标。
 */
function rulerStrip(
  axis: 'horizontal' | 'vertical',
  length: number,
  ticks: RulerTick[],
): ReturnType<typeof h> {
  const isRow = axis === 'horizontal'
  // 舞台还没测出尺寸时 length 会是负的（0 减掉拐角厚度），SVG 不接受负宽高
  const span = Math.max(0, length)

  return h(
    'div',
    {
      key: `ruler-${axis}`,
      'data-handle-id': isRow ? 'ruler-h' : 'ruler-v',
      style: stripStyle(isRow),
    },
    tickCanvas(isRow, span, ticks),
  )
}

/**
 * 标尺条的定位与外观：横条贴顶、竖条贴左，都从拐角之后起算。
 *
 * 分隔线只画靠内侧那一条（横条画下边、竖条画右边），外侧交给舞台边缘，
 * 否则拐角处会出现两条叠加的边框。
 */
function stripStyle(isRow: boolean): CSSProperties {
  const innerBorder = '1px solid var(--lc-border, rgba(15,23,42,.12))'
  return {
    position: 'absolute',
    left: isRow ? `${RULER}px` : '0',
    top: isRow ? '0' : `${RULER}px`,
    width: isRow ? `calc(100% - ${RULER}px)` : `${RULER}px`,
    height: isRow ? `${RULER}px` : `calc(100% - ${RULER}px)`,
    cursor: isRow ? 'ns-resize' : 'ew-resize',
    pointerEvents: 'auto',
    background: 'var(--lc-surface, #fff)',
    borderRight: isRow ? 'none' : innerBorder,
    borderBottom: isRow ? innerBorder : 'none',
    boxSizing: 'border-box',
    overflow: 'hidden',
  }
}

/** 标尺条内的刻度画布：横条沿 X 伸展、竖条沿 Y 伸展，另一轴固定为条厚 */
function tickCanvas(isRow: boolean, span: number, ticks: RulerTick[]): ReturnType<typeof h> {
  return h(
    'svg',
    {
      width: isRow ? span : RULER,
      height: isRow ? RULER : span,
      style: { display: 'block', pointerEvents: 'none' },
    },
    renderTicks(ticks, isRow),
  )
}

/**
 * 刻度图元：每条一个 line，主刻度追加 label。
 *
 * label 位置避让刻线：横条文字在刻线右侧、竖条在刻线上方。
 */
function renderTicks(ticks: RulerTick[], isRow: boolean): ReturnType<typeof h>[] {
  return ticks.flatMap((tick, index) => {
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
  })
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

/**
 * 拖拽中的草稿参考线：横线按舞台宽度铺满、竖线按舞台高度铺满。
 *
 * @param size 舞台宽高（屏幕 CSS 像素）
 */
function draftLine(
  draft: GuideDraft,
  toScreenX: (value: number) => number,
  toScreenY: (value: number) => number,
  size: Size,
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
