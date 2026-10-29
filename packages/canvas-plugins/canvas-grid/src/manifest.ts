import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'canvas-grid',
  displayName: '画布网格',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:grid'],
  certification: 'platform',
  executionProfile: 'inline',
  uiReview: 'inline',
  contributes: {
    canvasFeatures: [
      {
        id: 'grid',
        title: '画布网格',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 5,
        requires: ['canvas'],
      },
    ],
  },
}
