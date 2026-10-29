import { defineCanvasPlugin } from '@lc/contracts'
import { GRID_SETTING } from './constants'
import GridOverlay from './overlay'

export { manifest } from './manifest'

/** 网格插件：注册背景层与步长设置 */
export default defineCanvasPlugin({
  name: 'canvas-grid',
  inject: ['canvas'],

  apply(ctx) {
    const canvas = ctx.canvas

    ctx.effect(() =>
      canvas.settings.register<number>({
        id: GRID_SETTING,
        title: '网格大小',
        scope: 'workspace',
        schema: { type: 'number', minimum: 2, maximum: 100 },
        default: 8,
      }),
    )

    ctx.effect(() =>
      canvas.layers.register({
        id: 'canvas-grid.overlay',
        // background 是最低 band：网格在节点之下；pointerEvents none 让它不参与命中
        band: 'background',
        pointerEvents: 'none',
        load: () => Promise.resolve({ default: GridOverlay }),
      }),
    )
  },
})
