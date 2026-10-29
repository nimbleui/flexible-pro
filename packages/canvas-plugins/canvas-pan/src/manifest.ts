import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'canvas-pan',
  displayName: '画布平移',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:pan'],
  certification: 'platform',
  executionProfile: 'inline',
  contributes: {
    canvasFeatures: [
      {
        id: 'pan',
        title: '画布平移',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 11,
        requires: ['canvas'],
      },
    ],
  },
}
