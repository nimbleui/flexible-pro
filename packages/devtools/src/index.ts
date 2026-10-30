/**
 * 开发者工具包：插件树、服务表、依赖图、事件日志、配置、诊断与画布自省。
 *
 * 只读内核与各服务的公共面，不改装配顺序、不接管生命周期；三个动作
 * （重试 / 卸载 / 清空日志）都落在内核已有的公共方法上。
 */
export { default as LcDevtools } from './components/DevtoolsPanel.vue'
export { useDevtools } from './use-devtools'
export type { DevtoolsSource, DevtoolsState, DevtoolsSummary } from './use-devtools'
export type {
  BlockedPlugin,
  BlockedProvider,
  CanvasView,
  ConfigOverride,
  ContributionCount,
  DependencyEdge,
  DependencyView,
  DevtoolsScope,
  EventLogEntry,
  ManifestSummary,
  MissingServiceCandidate,
  PluginConfigView,
  PluginRow,
  ServiceChainLink,
  ServiceRow,
} from './core/types'
