import type { Point } from '@lc/contracts'
import { CANVAS_DROP_PREVIEW_SETTING } from '@lc/contracts'

/** 拖入预览在画布设置中的 id；与宿主共用契约常量 */
export const DROP_PREVIEW_SETTING = CANVAS_DROP_PREVIEW_SETTING

/** 无 snippet 时的默认落点尺寸 */
export const DEFAULT_DROP_WIDTH = 180
/** 无 snippet 时的默认落点高度（屏幕像素） */
export const DEFAULT_DROP_HEIGHT = 120

/** 拖入预览数据；由画布宿主在 dragover 时写入 */
export interface DropPreview {
  /** 物料名 */
  materialName: string
  /** 落点世界坐标 */
  world: Point
  /** 落点屏幕坐标 */
  screen: Point
  /** 命中的容器节点 id；未命中时为 undefined */
  containerId?: string
}
