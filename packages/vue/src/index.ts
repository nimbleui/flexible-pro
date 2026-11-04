/**
 * Vue 3 宿主适配层。
 *
 * - Context → Vue provide/inject
 * - 声明式贡献 → 通用插槽组件
 * - 画布服务 → 舞台与覆盖层组件
 * - 物料懒加载 → 渲染服务
 */

export {
  LC_CONTEXT,
  provideContext,
  useAppContext,
  useRegistryList,
  useService,
} from './context'

export { lcIconPaths } from './icons'

export type { SlotContent } from './slot-content'

export { HORIZONTAL_CONSTRAINTS, VERTICAL_CONSTRAINTS } from './render/constraints'
export type { HorizontalConstraint, VerticalConstraint } from './render/constraints'

export { default as LcIcon } from './components/LcIcon.vue'
export { default as LcSearchField } from './components/LcSearchField.vue'
export { default as LcSlot } from './components/Slot.vue'
export { default as ContextScope } from './components/ContextScope.vue'
export { default as PluginBoundary } from './components/PluginBoundary.vue'
export { default as CanvasStage } from './components/CanvasStage.vue'
export { default as LayerHost } from './components/LayerHost.vue'
export { default as SchemaPreview } from './components/SchemaPreview.vue'
export { default as PageRuntime } from './components/PageRuntime.vue'

export { eventListenerProp } from './render/events'

export { default as rendererPlugin } from './plugins/renderer'
