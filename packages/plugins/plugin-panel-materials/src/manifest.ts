import type { PluginManifest } from '@lc/contracts'

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
        title: '物料',
        slot: 'designer.leftPanel',
        module: './src/index.ts',
        order: 20,
        icon: 'grid',
      },
    ],
  },
}
