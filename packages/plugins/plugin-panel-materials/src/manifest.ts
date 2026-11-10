import type { PluginManifest } from '@lc/contracts'

/** 插件清单：声明插件名、依赖与贡献点，由内核在装配期读取并加载。 */
export const manifest: PluginManifest = {
  name: 'panel-materials',
  displayName: '物料面板',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  activationEvents: ['onPanel:materials'],
  certification: 'platform',
  executionProfile: 'inline',
  contributes: {
    panels: [
      {
        id: 'materials',
        title: '组件库',
        slot: 'designer.leftPanel',
        module: './src/index.ts',
        order: 20,
        icon: 'grid',
      },
    ],
  },
}
