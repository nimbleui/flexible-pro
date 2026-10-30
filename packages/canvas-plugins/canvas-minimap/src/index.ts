import { defineCanvasPlugin } from '@lc/contracts'
import { clamp } from '@lc/shared'
import { MINIMAP_SIZE, layoutFor, mapOrigin, toWorldPoint } from './geometry'
import MinimapOverlay from './overlay'

export { manifest } from './manifest'

/** 小地图手柄 id：覆盖层与交互处理器共用 */
const MINIMAP_HANDLE = 'minimap'

/**
 * 小地图插件。
 *
 * 按下或拖过小地图就把视口中心挪到被点中的世界位置；地图与视口框每帧由
 * `frame.viewport` 重算，所以画布缩放、平移都会立刻反映出来。
 */
export default defineCanvasPlugin({
  name: 'canvas-minimap',
  inject: ['canvas'],

  apply(ctx) {
    const canvas = ctx.canvas

    ctx.effect(() =>
      canvas.layers.register({
        id: 'canvas-minimap.overlay',
        band: 'hud',
        // 压在标尺之上、右键菜单之下（LayerHost 每层留 10 的 z 间隔，zIndex 必须 < 10）
        zIndex: 5,
        // children：整层不拦指针，只有右下角那块地图实体可以拖
        pointerEvents: 'children',
        load: () => Promise.resolve({ default: MinimapOverlay }),
      }),
    )

    /** 屏幕坐标 → 地图内容区本地坐标 → 世界坐标（本地坐标夹在地图盒内） */
    function worldAt(screen: { x: number; y: number }) {
      const origin = mapOrigin(canvas.viewport.size)
      const layout = layoutFor(
        canvas.scene.getRootBounds(),
        canvas.viewport.state,
        canvas.viewport.size,
      )
      // 手势期间指针可以滑出地图：夹住边界，抬手落点仍在地图内，
      // 否则一次滑出会瞬间把视口甩到很远的世界坐标
      const localX = clamp(screen.x - origin.x, 0, MINIMAP_SIZE.width)
      const localY = clamp(screen.y - origin.y, 0, MINIMAP_SIZE.height)
      return toWorldPoint(layout, localX, localY)
    }

    /** 把视口中心对齐到某个世界点；只改原点，缩放保持不变 */
    function centerOn(world: { x: number; y: number }): void {
      const size = canvas.viewport.size
      const zoom = canvas.viewport.state.zoom
      if (size.width === 0 || size.height === 0) return
      canvas.viewport.set({
        x: world.x - size.width / 2 / zoom,
        y: world.y - size.height / 2 / zoom,
      })
    }

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-minimap.pan',
        phase: 'target',
        priority: 120,
        when: (event) =>
          event.type === 'pointerdown' &&
          event.buttons === 1 &&
          event.targetHandleId === MINIMAP_HANDLE,
        handle: (event) => {
          if (event.type !== 'pointerdown') return 'pass'

          centerOn(worldAt(event.screen))

          ctx.effect(() =>
            canvas.interaction.beginGesture({
              onMove: (move) => centerOn(worldAt(move.screen)),
              // 地图只是导航，抬手没有任何需要提交的结果
              onFinish: () => undefined,
            }),
          )

          // 独占手势：在小地图上拖动不该同时触发框选
          return 'stop'
        },
      }),
    )
  },
})
