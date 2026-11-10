import type { PluginManifest } from '@lc/contracts'

/**
 * 版本面板贡献声明。
 *
 * 复用 `designer.bottomPanel`：底部停靠区天然支持多面板动态页签，不需要新增插槽，
 * 也不动右栏「四页签固定」的既有边界。`order: 20` 排在事件流之后。
 */
/** 插件清单：声明插件名、依赖与贡献点，由内核在装配期读取并加载。 */
export const manifest: PluginManifest = {
  name: 'panel-version',
  displayName: '版本管理',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  activationEvents: ['onPanel:version'],
  certification: 'platform',
  executionProfile: 'inline',
  contributes: {
    panels: [
      {
        id: 'version',
        title: '版本管理',
        slot: 'designer.bottomPanel',
        module: './src/index.ts',
        order: 20,
        icon: 'version',
      },
    ],
  },
}
