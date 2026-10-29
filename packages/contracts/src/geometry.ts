/**
 * 几何基础类型。
 *
 * 坐标语义随上下文而定：
 * - world：文档逻辑像素，schema 中的节点位置与尺寸
 * - screen：画布视口本地 CSS 像素，指针事件与覆盖层
 * 两者换算只允许通过 `CanvasService.viewport` 完成。
 */

export type { Rect, Size } from '@lc/schema'

/** 二维点 */
export interface Point {
  /** 水平坐标 */
  x: number
  /** 垂直坐标 */
  y: number
}
