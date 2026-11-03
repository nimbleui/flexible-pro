import type { Point, Rect, Size } from '@lc/contracts'

/**
 * 小地图投影。
 *
 * 纯几何：把世界矩形映射到固定尺寸的小地图盒子，并提供反向换算给「点哪儿视口就去哪儿」。
 * 单独成文件是因为这两条公式一旦写错，小地图会显示得正常但点击跳错位置——只有正反向
 * 都测过才能发现。
 */

/** 世界坐标与小地图坐标之间的双向映射 */
export interface MinimapProjection {
  /** 缩放系数（小地图像素 / 世界像素） */
  scale: number
  /** 世界原点在小地图上的落点 */
  offset: Point
  /** 世界矩形 → 小地图矩形 */
  project(rect: Rect): Rect
  /** 小地图坐标 → 世界点 */
  invert(point: Point): Point
}

/** 空图或零尺寸盒子时的兜底缩放，取 1 让反向换算仍然自洽 */
const FALLBACK_SCALE = 1

/**
 * 建立投影。
 *
 * 等比缩放取宽、高两个比例的小者并**封顶在 1**：小图按原尺寸居中显示，而不是被放大
 * 铺满盒子——一个节点占满整张小地图后，视口框和它就分不清了。大图仍然会缩到塞得下。
 *
 * 边界：`bounds` 宽高为 0（只有一个零尺寸节点）或盒子为 0 时用兜底缩放，
 * 避免除零得到 Infinity 后所有矩形都画不出来。
 *
 * @param bounds 图的世界外接矩形
 * @param size 小地图盒子尺寸
 * @param padding 盒子内边距
 * @returns 双向投影
 */
export function projectToMinimap(bounds: Rect, size: Size, padding = 8): MinimapProjection {
  const usableWidth = Math.max(size.width - padding * 2, 1)
  const usableHeight = Math.max(size.height - padding * 2, 1)

  const scale =
    bounds.width > 0 && bounds.height > 0
      ? Math.min(1, usableWidth / bounds.width, usableHeight / bounds.height)
      : FALLBACK_SCALE

  // 图小于盒子时按实际尺寸居中，而不是把缩放拉大到填满——否则一个节点会铺满整张小地图
  const drawnWidth = bounds.width * scale
  const drawnHeight = bounds.height * scale
  const offset = {
    x: padding + (usableWidth - drawnWidth) / 2 - bounds.x * scale,
    y: padding + (usableHeight - drawnHeight) / 2 - bounds.y * scale,
  }

  return {
    scale,
    offset,
    project: (rect) => ({
      x: rect.x * scale + offset.x,
      y: rect.y * scale + offset.y,
      width: rect.width * scale,
      height: rect.height * scale,
    }),
    invert: (point) => ({
      x: (point.x - offset.x) / scale,
      y: (point.y - offset.y) / scale,
    }),
  }
}
