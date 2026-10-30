import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'canvas-context-menu',
  displayName: '右键菜单',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:contextMenu'],
  certification: 'platform',
  executionProfile: 'inline',
  uiReview: 'inline',
  contributes: {
    canvasFeatures: [
      {
        id: 'contextMenu',
        title: '右键菜单',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 95,
        requires: ['canvas'],
      },
    ],
  },
}
