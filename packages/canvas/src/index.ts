/**
 * 画布微内核（框架无关）。
 *
 * 只提供坐标、场景、交互管线、图层、事务、调度与吸附引擎；
 * 缩放/平移/选择/拖拽/缩放旋转手柄/辅助线/网格全部是画布插件。
 */

export { createViewport } from './viewport'
export type { CreateViewportOptions } from './viewport'

export { createScene } from './scene'
export type { CreateSceneOptions } from './scene'

export { createHitTest, createMeasure } from './hitTest'
export type { CreateHitTestOptions } from './hitTest'

export { createInteractionPipeline } from './interaction/pipeline'
export type { CreateInteractionOptions, InteractionPipeline } from './interaction/pipeline'

export { createLayerService } from './layers'
export { createContextMenuService } from './menu'
export { createScheduler } from './scheduler'
export type { SchedulerHandle } from './scheduler'
export { createSettingsService } from './settings'

export { createTransactionService } from './transaction'
export type { CreateTransactionOptions } from './transaction'

export { createSnapService } from './snap/engine'
export type { CreateSnapServiceOptions } from './snap/engine'

export {
  applyMatrix,
  IDENTITY,
  invertMatrix,
  multiplyMatrix,
  normalizeRect,
  rectContainsPoint,
  rectIntersects,
  rotatePoint,
  unionRects,
} from './geometry'
