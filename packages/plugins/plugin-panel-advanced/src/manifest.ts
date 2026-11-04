import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'panel-advanced',
  displayName: '高级面板',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  activationEvents: ['onPanel:advanced'],
  certification: 'platform',
  executionProfile: 'inline',
  contributes: {
    panels: [
      {
        id: 'advanced',
        title: '高级',
        slot: 'designer.advancedPanel',
        module: './src/index.ts',
        order: 10,
        icon: 'sliders',
      },
    ],
  },
}
