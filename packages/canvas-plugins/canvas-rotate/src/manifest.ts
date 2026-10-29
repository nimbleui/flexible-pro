import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'canvas-rotate',
  displayName: '节点旋转',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:rotate'],
  certification: 'platform',
  executionProfile: 'inline',
  uiReview: 'inline',
  requires: ['canvas'],
  contributes: {
    canvasFeatures: [
      {
        id: 'rotate',
        title: '节点旋转',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 55,
        requires: ['canvas'],
      },
    ],
  },
}
