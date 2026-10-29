import { defineCanvasPlugin } from '@lc/contracts'
import GuidesOverlay from './overlay'

export { manifest } from './manifest'

/**
 * 辅助线插件。
 *
 * 只注册覆盖层，吸附计算属于 canvas-snap；卸载本插件不影响吸附本身。
 */
export default defineCanvasPlugin({
  name: 'canvas-guides',
  inject: ['canvas'],

  apply(ctx) {
    ctx.effect(() =>
      ctx.canvas.layers.register({
        id: 'canvas-guides.overlay',
        // guides band 在 handles 之下：辅助线不应盖住拖拽手柄
        band: 'guides',
        pointerEvents: 'none',
        // 没有吸附结果时整层不可见，覆盖层模块也因此不会被加载
        visible: (frame) => (frame.snap?.guides.length ?? 0) > 0,
        load: () => Promise.resolve({ default: GuidesOverlay }),
      }),
    )
  },
})
