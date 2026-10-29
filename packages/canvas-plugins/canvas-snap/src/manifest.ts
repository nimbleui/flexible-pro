import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'canvas-snap',
  displayName: '画布吸附',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:snap'],
  certification: 'platform',
  executionProfile: 'inline',
  provides: ['snap'],
  contributes: {
    canvasFeatures: [
      {
        id: 'snap',
        title: '画布吸附',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 30,
        requires: ['canvas'],
        config: { thresholdScreenPx: 6, gridSize: 8 },
      },
    ],
  },
}
