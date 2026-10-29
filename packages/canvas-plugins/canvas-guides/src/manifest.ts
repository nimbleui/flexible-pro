import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'canvas-guides',
  displayName: '对齐辅助线',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:guides'],
  certification: 'platform',
  executionProfile: 'inline',
  uiReview: 'inline',
  contributes: {
    canvasFeatures: [
      {
        id: 'guides',
        title: '对齐辅助线',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 60,
        requires: ['canvas'],
      },
    ],
  },
}
