import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'panel-properties',
  displayName: '属性面板',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  activationEvents: ['onPanel:properties'],
  certification: 'platform',
  executionProfile: 'inline',
  contributes: {
    panels: [
      {
        id: 'properties',
        title: '属性',
        slot: 'designer.rightPanel',
        module: './src/index.ts',
        order: 10,
        icon: 'sliders',
      },
    ],
  },
}
