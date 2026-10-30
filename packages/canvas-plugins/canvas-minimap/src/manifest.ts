import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'canvas-minimap',
  displayName: '小地图',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:minimap'],
  certification: 'platform',
  executionProfile: 'inline',
  uiReview: 'inline',
  contributes: {
    canvasFeatures: [
      {
        id: 'minimap',
        title: '小地图',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 80,
        requires: ['canvas'],
      },
    ],
  },
}
