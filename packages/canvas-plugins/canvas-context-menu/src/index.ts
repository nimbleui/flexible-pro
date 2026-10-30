import type { CanvasMenuTarget } from '@lc/contracts'
import { CANVAS_CONTEXT_MENU_STATE, defineCanvasPlugin } from '@lc/contracts'
import { createMenuItems } from './items'
import ContextMenuOverlay from './overlay'

export { manifest } from './manifest'

/**
 * 右键菜单插件。
 *
 * - 右键命中节点：先把选中集收敛到该节点，再打开菜单
 * - 空白处右键：只打开菜单，不动选中集（粘贴、全选仍作用于当前选中）
 * - 左键按下、滚轮、Esc 都会关闭菜单；菜单自身拦住 pointerdown，
 *   所以点菜单项不会被上面的规则当成「点击画布别处」提前关掉
 */
export default defineCanvasPlugin({
  name: 'canvas-context-menu',
  inject: ['canvas'],

  apply(ctx) {
    const canvas = ctx.canvas

    const readState = (): CanvasMenuTarget | null =>
      canvas.settings.get<CanvasMenuTarget | null>(CANVAS_CONTEXT_MENU_STATE) ?? null

    const isOpen = (): boolean => readState() !== null

    const close = (): void => {
      if (!isOpen()) return
      canvas.settings.set<CanvasMenuTarget | null>(CANVAS_CONTEXT_MENU_STATE, null)
      canvas.scheduler.invalidateViewport()
    }

    ctx.effect(() =>
      canvas.settings.register<CanvasMenuTarget | null>({
        id: CANVAS_CONTEXT_MENU_STATE,
        title: '右键菜单状态',
        scope: 'document',
        schema: {},
        default: null,
      }),
    )

    ctx.effect(() =>
      canvas.layers.register({
        id: 'canvas-context-menu.overlay',
        band: 'hud',
        // LayerHost 的层级算法是每个图层 z = 图层序号 × 10 + zIndex，zIndex 到 10
        // 就会与下一个 band 相撞，所以 hud 内取上限 9 表示「标尺/小地图之上」
        zIndex: 9,
        // children：菜单没打开时这一层完全不拦指针
        pointerEvents: 'children',
        visible: () => isOpen(),
        load: () => Promise.resolve({ default: ContextMenuOverlay }),
      }),
    )

    for (const item of createMenuItems(canvas.selection)) {
      ctx.effect(() => canvas.contextMenu.register(item))
    }

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-context-menu.open',
        phase: 'bubble',
        priority: 120,
        when: (event) => event.type === 'contextmenu',
        handle: (event) => {
          if (event.type !== 'contextmenu') return 'pass'

          // 浏览器原生菜单必须压掉，否则画布右键不可用
          event.preventDefault()

          const nodeId = event.targetNodeId
          if (nodeId && !canvas.selection.ids.includes(nodeId)) {
            canvas.selection.set([nodeId])
          }

          canvas.settings.set<CanvasMenuTarget | null>(CANVAS_CONTEXT_MENU_STATE, {
            nodeId,
            screen: event.screen,
            world: event.world,
          })
          canvas.scheduler.invalidateViewport()
          return 'handled'
        },
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-context-menu.close',
        // capture 且最高优先级：先收菜单，再把事件原样交给选择与拖拽插件
        phase: 'capture',
        priority: 200,
        when: (event) =>
          isOpen() &&
          ((event.type === 'pointerdown' && event.buttons === 1) || event.type === 'wheel'),
        handle: () => {
          close()
          return 'pass'
        },
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-context-menu.escape',
        phase: 'capture',
        priority: 200,
        when: (event) => event.type === 'keydown' && event.key === 'Escape' && isOpen(),
        handle: (event) => {
          event.preventDefault()
          close()
          return 'handled'
        },
      }),
    )
  },
})
