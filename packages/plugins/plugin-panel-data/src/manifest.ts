import type { PluginManifest } from '@lc/contracts'

/** 插件清单：声明插件名、依赖与贡献点，由内核在装配期读取并加载。 */
export const manifest: PluginManifest = {
  name: 'panel-data',
  displayName: '数据绑定面板',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  activationEvents: ['onPanel:data'],
  certification: 'platform',
  executionProfile: 'inline',
  contributes: {
    panels: [
      {
        id: 'data',
        title: '数据绑定',
        slot: 'designer.bottomPanel',
        module: './src/index.ts',
        order: 20,
        icon: 'database',
      },
    ],
  },
}
