import type { PluginManifest } from '@lc/contracts'

/** 插件清单：声明插件名、依赖与贡献点，由内核在装配期读取并加载。 */
export const manifest: PluginManifest = {
  name: 'canvas-zoom',
  displayName: '画布缩放',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:zoom'],
  certification: 'platform',
  executionProfile: 'inline',
  contributes: {
    canvasFeatures: [
      {
        id: 'zoom',
        title: '画布缩放',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 10,
        requires: ['canvas'],
      },
    ],
    toolbar: [
      {
        id: 'zoom.out',
        title: '缩小',
        slot: 'designer.toolbar',
        command: 'canvas.zoomOut',
        order: 20,
      },
      {
        id: 'zoom.in',
        title: '放大',
        slot: 'designer.toolbar',
        command: 'canvas.zoomIn',
        order: 21,
      },
      {
        id: 'zoom.reset',
        title: '100%',
        slot: 'designer.toolbar',
        command: 'canvas.zoomReset',
        order: 22,
      },
      {
        id: 'zoom.fit',
        title: '适应画布',
        slot: 'designer.toolbar',
        command: 'canvas.zoomFit',
        order: 23,
      },
    ],
  },
}
