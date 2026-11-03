import type { Point } from '@lc/contracts'
import type { Rect, Size } from '@lc/schema'

/** 小地图内容区尺寸（屏幕像素），覆盖层与平移手势共用同一个盒子才能点哪走哪 */
export const MINIMAP_SIZE: Size = { width: 180, height: 120 }
/** 距离舞台右下边缘的空隙 */
export const MINIMAP_MARGIN = 12
/** 顶部标题条高度，内容区从它下面开始 */
export const MINIMAP_HEADER = 20

/** 视口状态里换算世界矩形需要的字段（避免依赖整个视口服务） */
export interface ViewportSnapshot {
  /** 舞台左上角对应的世界坐标 X（世界单位，非屏幕像素） */
  x: number
  /** 舞台左上角对应的世界坐标 Y（世界单位，非屏幕像素） */
  y: number
  /** 世界 → 屏幕的等比缩放系数，恒为正数 */
  zoom: number
}

/** 小地图在舞台本地的左上角坐标 */
export function mapOrigin(stage: Size): Point {
  return {
    x: stage.width - MINIMAP_SIZE.width - MINIMAP_MARGIN,
    y: stage.height - MINIMAP_SIZE.height - MINIMAP_MARGIN - MINIMAP_HEADER,
  }
}

/**
 * 当前可见的世界矩形。
 *
 * 只换算左上、右下两角：视口 rotation 为 0 时准确，旋转视图下是偏小的 AABB，
 * 与 canvas-drag 的视口裁剪同口径。
 */
export function viewportWorldRect(viewport: ViewportSnapshot, size: Size): Rect {
  return {
    x: viewport.x,
    y: viewport.y,
    width: size.width / viewport.zoom,
    height: size.height / viewport.zoom,
  }
}

/** 小地图内容区的映射结果 */
export interface MinimapLayout {
  /** 世界 → 小地图的统一缩放（等比，不拉伸） */
  scale: number
  /** 世界包围盒左上角映射到内容区原点后再居中的偏移（内容区本地 CSS 像素） */
  offsetX: number
  /** 与 offsetX 同口径，作用于 Y 轴（内容区本地 CSS 像素） */
  offsetY: number
}

/**
 * 把世界包围盒等比塞进固定盒子。
 *
 * `bounds` 退化（宽高为 0，空文档）时按 1 处理：scale 会变成 Infinity 或 NaN，
 * 小地图上的矩形随之全部消失，这里给一个可读的兜底比例而不是崩掉。
 * 留 8% 边距，避免文档边界贴死在小地图上看不清。
 */
export function fitLayout(bounds: Rect, box: Size): MinimapLayout {
  const padding = 0.92
  const width = Math.max(bounds.width, 1)
  const height = Math.max(bounds.height, 1)
  const scale = Math.min((box.width * padding) / width, (box.height * padding) / height)

  return {
    scale,
    offsetX: (box.width - width * scale) / 2 - bounds.x * scale,
    offsetY: (box.height - height * scale) / 2 - bounds.y * scale,
  }
}

/**
 * 世界矩形映射到小地图内容区后的绝对定位盒子。
 *
 * 不复用 `Rect`：覆盖层直接把它写进 `left` / `top`，用 x/y 命名反而要再换算一次。
 * 四个值都是地图内容区本地 CSS 像素；宽高下限 0.5px，防止极小节点在小地图上整体消失。
 */
interface MapRectBox {
  /** 矩形左缘的绝对定位偏移 */
  left: number
  /** 矩形上缘的绝对定位偏移 */
  top: number
  /** 缩放后的显示宽度 */
  width: number
  /** 缩放后的显示高度 */
  height: number
}

/** 世界矩形 → 小地图矩形（绝对定位用） */
export function toMapRect(layout: MinimapLayout, rect: Rect): MapRectBox {
  return {
    left: rect.x * layout.scale + layout.offsetX,
    top: rect.y * layout.scale + layout.offsetY,
    width: Math.max(rect.width * layout.scale, 0.5),
    height: Math.max(rect.height * layout.scale, 0.5),
  }
}

/**
 * 小地图坐标 → 世界坐标。
 *
 * 与 `toMapRect` 严格互逆：点击小地图要落回用户点的那个位置，两个方向的手算
 * 公式各写一份迟早会分叉，所以这里只做一次反解。
 *
 * @param x 地图内容区本地 CSS 像素横坐标
 * @param y 地图内容区本地 CSS 像素纵坐标
 * @returns 反解出的世界坐标（世界单位）
 */
export function toWorldPoint(layout: MinimapLayout, x: number, y: number): Point {
  return { x: (x - layout.offsetX) / layout.scale, y: (y - layout.offsetY) / layout.scale }
}

/** 两个矩形的并集；任一侧为空时返回另一侧 */
export function unionOf(a: Rect | undefined, b: Rect | undefined): Rect | undefined {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

/**
 * 覆盖层与平移手势共用的映射。
 *
 * 两边各自算一遍 bounds 迟早分叉——点击落点与图上画出来的视口框差几个像素就是
 * 「点不准」，所以这里一次算完：范围取文档与可见区的并集。
 */
export function layoutFor(
  rootBounds: Rect,
  viewport: ViewportSnapshot,
  stage: Size,
): MinimapLayout {
  const visible = viewportWorldRect(viewport, stage)
  return fitLayout(unionOf(rootBounds, visible) ?? visible, MINIMAP_SIZE)
}
