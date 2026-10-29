import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'canvas-drop',
  displayName: '物料拖入',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:drop'],
  certification: 'platform',
  executionProfile: 'inline',
  uiReview: 'inline',
  requires: ['canvas'],
  contributes: {
    canvasFeatures: [
      {
        id: 'drop',
        title: '物料拖入',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 80,
        requires: ['canvas'],
      },
    ],
  },
}
