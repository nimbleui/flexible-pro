import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'panel-eventflow',
  displayName: '事件流面板',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  activationEvents: ['onPanel:eventflow'],
  certification: 'platform',
  executionProfile: 'inline',
  contributes: {
    panels: [
      {
        id: 'eventflow',
        title: '事件流',
        slot: 'designer.bottomPanel',
        module: './src/index.ts',
        order: 10,
      },
    ],
  },
}
