import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'canvas-drag',
  displayName: '节点拖拽',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:drag'],
  certification: 'platform',
  executionProfile: 'inline',
  requires: ['canvas'],
  contributes: {
    canvasFeatures: [
      {
        id: 'drag',
        title: '节点拖拽',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 40,
        requires: ['canvas'],
      },
    ],
  },
}
