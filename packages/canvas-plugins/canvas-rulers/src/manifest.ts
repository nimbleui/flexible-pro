import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'canvas-rulers',
  displayName: '标尺与参考线',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:rulers'],
  certification: 'platform',
  executionProfile: 'inline',
  uiReview: 'inline',
  contributes: {
    canvasFeatures: [
      {
        id: 'rulers',
        title: '标尺与参考线',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 65,
        requires: ['canvas'],
      },
    ],
  },
}
