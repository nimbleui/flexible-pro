import type { PluginManifest } from '@lc/contracts'

export const manifest: PluginManifest = {
  name: 'canvas-align',
  displayName: '对齐与分布',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:align'],
  certification: 'platform',
  executionProfile: 'inline',
  contributes: {
    canvasFeatures: [
      {
        id: 'align',
        title: '对齐与分布',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 70,
        requires: ['canvas'],
      },
    ],
    toolbar: [
      {
        id: 'align.left',
        title: '左对齐',
        slot: 'designer.toolbar',
        command: 'canvas.alignLeft',
        order: 40,
      },
      {
        id: 'align.centerX',
        title: '水平居中',
        slot: 'designer.toolbar',
        command: 'canvas.alignCenterX',
        order: 41,
      },
      {
        id: 'align.right',
        title: '右对齐',
        slot: 'designer.toolbar',
        command: 'canvas.alignRight',
        order: 42,
      },
      {
        id: 'align.top',
        title: '顶对齐',
        slot: 'designer.toolbar',
        command: 'canvas.alignTop',
        order: 43,
      },
      {
        id: 'align.centerY',
        title: '垂直居中',
        slot: 'designer.toolbar',
        command: 'canvas.alignCenterY',
        order: 44,
      },
      {
        id: 'align.bottom',
        title: '底对齐',
        slot: 'designer.toolbar',
        command: 'canvas.alignBottom',
        order: 45,
      },
      {
        id: 'align.distributeX',
        title: '水平分布',
        slot: 'designer.toolbar',
        command: 'canvas.distributeX',
        order: 46,
      },
      {
        id: 'align.distributeY',
        title: '垂直分布',
        slot: 'designer.toolbar',
        command: 'canvas.distributeY',
        order: 47,
      },
    ],
  },
}
