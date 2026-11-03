import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'panel-outline',
  displayName: '页面大纲面板',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  activationEvents: ['onPanel:outline'],
  certification: 'platform',
  executionProfile: 'inline',
  contributes: {
    panels: [
      {
        id: 'outline',
        title: '页面大纲',
        slot: 'designer.overlayPanel',
        module: './src/index.ts',
        order: 10,
        icon: 'outline',
      },
    ],
  },
}
