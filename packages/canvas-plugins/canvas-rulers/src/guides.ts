import type { SnapCandidate, SnapContext } from '@lc/contracts'
import type { Rect } from '@lc/schema'

/** 参考线轴向；horizontal 是水平线（世界 Y 固定），vertical 是垂直线（世界 X 固定） */
export type GuideAxis = 'horizontal' | 'vertical'

/** 用户参考线集合，值全部是世界坐标 */
export interface UserGuides {
  horizontal: number[]
  vertical: number[]
}

/** 拖拽标尺时的草稿线；落在参考线设置之外，避免拖动过程反复写文档态数据 */
export interface GuideDraft {
  axis: GuideAxis
  value: number
}

/** 空集合：设置未注册或文档刚打开时的默认值 */
export const EMPTY_GUIDES: UserGuides = { horizontal: [], vertical: [] }

/** 参考线设置 id（画布设置，scope=document）与显示名 */
export const USER_GUIDES_SETTING = 'canvas-rulers.guides'
export const GUIDE_DRAFT_SETTING = 'canvas-rulers.draft'
export const USER_GUIDES_LABEL = '用户参考线'
export const GUIDE_DRAFT_LABEL = '参考线草稿'

/** 手柄 id 前缀：覆盖层与交互处理器共用，改一边另一边立刻对不上，所以集中在这里 */
export const RULER_HANDLE = { horizontal: 'ruler-h', vertical: 'ruler-v' } as const
export const GUIDE_HANDLE_PREFIX = 'guide-'

/** 由轴向 + 下标生成参考线手柄 id */
export function guideHandleId(axis: GuideAxis, index: number): string {
  return `${GUIDE_HANDLE_PREFIX}${axis === 'horizontal' ? 'h' : 'v'}-${index}`
}

/**
 * 解析参考线手柄 id。
 *
 * 下标是「当时数组里的位置」，只在一次手势内有效：手势期间不增删参考线，
 * 所以移动过程可以放心按下标回写。非参考线手柄返回 undefined。
 */
export function parseGuideHandleId(
  handleId: string,
): { axis: GuideAxis; index: number } | undefined {
  if (!handleId.startsWith(GUIDE_HANDLE_PREFIX)) return undefined
  const body = handleId.slice(GUIDE_HANDLE_PREFIX.length)
  const separator = body.lastIndexOf('-')
  if (separator < 0) return undefined
  const axis = body.slice(0, separator)
  const index = Number(body.slice(separator + 1))
  if (!Number.isInteger(index) || index < 0) return undefined
  if (axis === 'h') return { axis: 'horizontal', index }
  if (axis === 'v') return { axis: 'vertical', index }
  return undefined
}

function withAxis(guides: UserGuides, axis: GuideAxis, values: number[]): UserGuides {
  return axis === 'horizontal'
    ? { ...guides, horizontal: values }
    : { ...guides, vertical: values }
}

/** 追加一条参考线；同值重复追加没有意义，直接返回原集合 */
export function addGuide(guides: UserGuides, axis: GuideAxis, value: number): UserGuides {
  const values = guides[axis]
  if (values.includes(value)) return guides
  return withAxis(guides, axis, [...values, value])
}

/** 按下标移动一条参考线 */
export function moveGuide(
  guides: UserGuides,
  axis: GuideAxis,
  index: number,
  value: number,
): UserGuides {
  const values = guides[axis]
  if (index < 0 || index >= values.length) return guides
  const next = [...values]
  next[index] = value
  return withAxis(guides, axis, next)
}

/** 按下标删除一条参考线 */
export function removeGuide(guides: UserGuides, axis: GuideAxis, index: number): UserGuides {
  const values = guides[axis]
  if (index < 0 || index >= values.length) return guides
  return withAxis(
    guides,
    axis,
    values.filter((_, position) => position !== index),
  )
}

/**
 * 参考线吸附候选。
 *
 * 只取视口附近（含阈值余量）的线，远处的线不参与比较：候选数量与屏幕可见范围
 * 挂钩，放大文档也不会拖慢每一帧的吸附计算。
 * `priority: 2` 高于元素对齐（1）：参考线是用户显式放下的意图，不该被附近节点的
 * 边抢走吸附结果。
 * `showGuide: false`：参考线本来就画在画布上，吸附时再叠一条同位置的临时线只会闪一下。
 */
export function guideCandidates(guides: UserGuides, context: SnapContext): SnapCandidate[] {
  const margin = context.thresholdWorld
  const candidates: SnapCandidate[] = []

  for (const value of guides.horizontal) {
    if (outsideBand(value, context.viewportRect, 'y', margin)) continue
    candidates.push({ axis: 'y', value, source: 'guide', priority: 2, showGuide: false })
  }
  for (const value of guides.vertical) {
    if (outsideBand(value, context.viewportRect, 'x', margin)) continue
    candidates.push({ axis: 'x', value, source: 'guide', priority: 2, showGuide: false })
  }

  return candidates
}

function outsideBand(value: number, rect: Rect, axis: 'x' | 'y', margin: number): boolean {
  const start = axis === 'x' ? rect.x : rect.y
  const end = start + (axis === 'x' ? rect.width : rect.height)
  return value < start - margin || value > end + margin
}

/**
 * 标尺刻度步进。
 *
 * 在 1-2-5 序列里挑最小的、使主刻度屏幕间距不小于 `minGapPx` 的步进，
 * 于是缩放时刻度密度基本恒定，不会在小倍率下糊成一片、大倍率下只剩一条线。
 */
export function rulerStep(zoom: number, minGapPx = 64): number {
  if (zoom <= 0) return 1
  const raw = minGapPx / zoom
  const exponent = Math.floor(Math.log10(raw))
  const base = Math.pow(10, exponent)
  const normalized = raw / base

  if (normalized <= 1) return base
  if (normalized <= 2) return 2 * base
  if (normalized <= 5) return 5 * base
  return 10 * base
}

/** 主刻度之间的细分格数 */
const MINOR_DIVISIONS = 5

/** 一条刻度 */
export interface RulerTick {
  /** 相对标尺条起点的屏幕像素位置；原点已经让给了左上角的空白方块 */
  at: number
  /** 主刻度带文字与长刻线 */
  major: boolean
  /** 主刻度的数值文本；次刻度为 undefined */
  label?: string
}

/** 刻度生成输入 */
export interface RulerTickInput {
  /** 舞台起点对应的世界坐标，即视口左上角的世界值 */
  originWorld: number
  /** 视口缩放 */
  zoom: number
  /** 标尺条起点相对舞台起点的偏移，即空白方块的厚度（屏幕像素） */
  inset: number
  /** 舞台在主轴上的长度（屏幕像素） */
  stageLength: number
}

/**
 * 生成标尺刻度，返回位置位于**标尺条自身的坐标空间**。
 *
 * 刻度条被 `inset` 让给了左上角空白方块，所以不能直接把舞台屏幕坐标写进去：
 * 那样整条刻度会相对内容偏出一个 inset，末端一圈刻度还会被 overflow 裁掉。
 * 这里统一减掉 inset，并按标尺条可用长度过滤，渲染层原样落位即可。
 * 落在条外的刻度直接丢弃：SVG 里留几千个不可见的 line 会让每次平移都重画一遍。
 */
export function rulerTicks(input: RulerTickInput): RulerTick[] {
  const { originWorld, zoom, inset, stageLength } = input
  const length = stageLength - inset
  if (!(length > 0) || !Number.isFinite(zoom) || !(zoom > 0)) return []

  const step = rulerStep(zoom)
  const minor = step / MINOR_DIVISIONS
  const endWorld = originWorld + stageLength / zoom
  const ticks: RulerTick[] = []

  for (let value = Math.floor(originWorld / minor) * minor; value <= endWorld; value += minor) {
    const at = (value - originWorld) * zoom - inset
    if (at < -1 || at > length + 1) continue
    const isMajor = Math.abs(value / step - Math.round(value / step)) < 1e-6
    ticks.push({ at, major: isMajor, label: isMajor ? formatTickLabel(value) : undefined })
  }

  return ticks
}

/** 刻度文字：1e-6 容差去掉浮点尾巴，整数不带小数 */
function formatTickLabel(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}
