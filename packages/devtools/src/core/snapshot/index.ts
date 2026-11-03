/**
 * 自省快照采集：把内核 Context 树与各服务的公共面读成面板可直接渲染的普通对象。
 *
 * 目录按「采集对象」分文件，彼此不互相依赖，只共用 `../types` 里的视图类型：
 * scopes 定层、plugins/services 展平记录、dependencies 重算依赖图、
 * config/canvas 取单实例配置与画布状态、record 负责按 id 定位记录。
 */

export { collectScopes } from './scopes'
export { collectPlugins } from './plugins'
export { collectServices } from './services'
export { buildDependencies } from './dependencies'
export { buildConfigView } from './config'
export { buildCanvasView } from './canvas'
export type { LocatedRecord } from './record'
export { findRecord } from './record'
