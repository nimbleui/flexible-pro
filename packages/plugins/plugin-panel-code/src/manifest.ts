import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'panel-code',
  displayName: '代码面板',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  activationEvents: ['onPanel:code'],
  certification: 'platform',
  executionProfile: 'inline',
  contributes: {
    panels: [
      {
        id: 'code',
        title: '代码',
        slot: 'designer.bottomPanel',
        module: './src/index.ts',
        order: 30,
        icon: 'code',
      },
    ],
  },
}
