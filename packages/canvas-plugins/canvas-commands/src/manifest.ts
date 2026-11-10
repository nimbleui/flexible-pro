import type { PluginManifest } from '@lc/contracts'

/** 插件清单：声明插件名、依赖与贡献点，由内核在装配期读取并加载。 */
export const manifest: PluginManifest = {
  name: 'canvas-commands',
  displayName: '编辑命令与快捷键',
  version: '0.1.0',
  engines: { lowcode: '^0.1.0' },
  main: './src/index.ts',
  activationEvents: ['onCanvasFeature:commands'],
  certification: 'platform',
  executionProfile: 'inline',
  requires: ['canvas'],
  contributes: {
    canvasFeatures: [
      {
        id: 'commands',
        title: '编辑命令与快捷键',
        module: './src/index.ts',
        defaultEnabled: true,
        order: 90,
        requires: ['canvas'],
      },
    ],
    // 结构类命令的按钮入口；快捷键在插件里同时注册，工具栏只是给个可见落点
    toolbar: [
      {
        id: 'commands.group',
        title: '组合',
        slot: 'designer.toolbar',
        command: 'canvas.group',
        order: 50,
      },
      {
        id: 'commands.ungroup',
        title: '取消组合',
        slot: 'designer.toolbar',
        command: 'canvas.ungroup',
        order: 51,
      },
      {
        id: 'commands.orderFront',
        title: '置于顶层',
        slot: 'designer.toolbar',
        command: 'canvas.orderFront',
        order: 52,
      },
      {
        id: 'commands.orderForward',
        title: '上移一层',
        slot: 'designer.toolbar',
        command: 'canvas.orderForward',
        order: 53,
      },
      {
        id: 'commands.orderBackward',
        title: '下移一层',
        slot: 'designer.toolbar',
        command: 'canvas.orderBackward',
        order: 54,
      },
      {
        id: 'commands.orderBack',
        title: '置于底层',
        slot: 'designer.toolbar',
        command: 'canvas.orderBack',
        order: 55,
      },
      {
        id: 'commands.toggleHidden',
        title: '隐藏 / 显示',
        slot: 'designer.toolbar',
        command: 'canvas.toggleHidden',
        order: 56,
      },
      {
        id: 'commands.toggleLock',
        title: '锁定 / 解锁',
        slot: 'designer.toolbar',
        command: 'canvas.toggleLock',
        order: 57,
      },
    ],
  },
}
