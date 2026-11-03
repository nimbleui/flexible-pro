import { defineCanvasPlugin } from '@lc/contracts'
import type { KeybindingService, Point } from '@lc/contracts'
import { clamp } from '@lc/shared'

export { manifest } from './manifest'

/** 缩放上下限，与视口服务的默认区间一致 */
const MIN_ZOOM = 0.1
const MAX_ZOOM = 4

/** 键盘与按钮每次点击的缩放倍率 */
const STEP = 1.2

/**
 * 滚轮 deltaY 到缩放倍率的指数映射系数。
 *
 * 用 `exp(-deltaY × k)` 而不是线性加减：倍率恒为正、放大缩小天然对称，
 * 且连续滚动累积效果与滚动次数无关（一次 200 与两次 100 等价）。
 */
const WHEEL_SENSITIVITY = 0.0015

/**
 * 画布缩放插件。
 *
 * 只操作视口：滚轮（Ctrl/⌘）、快捷键、命令与工具栏按钮共享同一套
 * `zoomAt(center)` 逻辑。卸载后视口状态保留，只是交互入口消失。
 */
export default defineCanvasPlugin({
  name: 'canvas-zoom',
  // 缩放命令是核心入口，键位只是可选加速方式
  inject: { required: ['canvas', 'command'], optional: ['keybinding'] },

  apply(ctx) {
    const canvas = ctx.canvas

    /**
     * 向目标倍率收敛。
     *
     * 插件先按自己的 MIN/MAX 夹紧，再把 `target / current` 交给视口：视口的区间
     * 由宿主创建时决定，可能比这里更宽，预夹紧保证缩放范围以本插件语义为准。
     * 已在上下限时直接返回，省掉一次视口写入与通知。
     *
     * @param screen 缩放锚点的屏幕坐标（CSS 像素，相对舞台原点；滚轮用指针位置、命令用视口中心）
     */
    function zoomTowards(screen: Point, factor: number): void {
      const current = canvas.viewport.state.zoom
      const target = clamp(current * factor, MIN_ZOOM, MAX_ZOOM)
      if (target === current) return
      canvas.viewport.zoomAt(screen, target / current)
    }

    /** 围绕视口中心缩放；尺寸未测量（0×0）时跳过，否则会围绕错误原点缩放 */
    function zoomCenter(factor: number): void {
      const size = canvas.viewport.size
      if (size.width === 0 || size.height === 0) return
      zoomTowards({ x: size.width / 2, y: size.height / 2 }, factor)
    }

    /**
     * 回到 100%。
     *
     * 走 zoomAt 而不是直接 `set({ zoom: 1 })`：前者会同步调整 origin，让画面中心
     * 的世界点保持在屏幕中心，重置缩放时视角不会跳走。
     */
    function resetZoom(): void {
      const size = canvas.viewport.size
      if (size.width === 0 || size.height === 0) return
      const current = canvas.viewport.state.zoom
      canvas.viewport.zoomAt({ x: size.width / 2, y: size.height / 2 }, 1 / current)
    }

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-zoom.wheel',
        phase: 'bubble',
        priority: 30,
        // 只在按住 Ctrl / ⌘ 时接管滚轮，普通滚轮留给页面滚动与平移插件
        when: (event) =>
          event.type === 'wheel' && (event.modifiers.ctrl || event.modifiers.meta),
        handle: (event) => {
          if (event.type !== 'wheel') return 'pass'

          // 管线以 passive:false 注册 wheel，这里才允许阻止浏览器整页缩放
          event.preventDefault()

          // 管线的 delta 恒为 0，滚动量只能从原生事件读；type 收窄后 TS 仍把
          // originalEvent 视为指针/滚轮/鼠标三者的联合，故在此断言
          const wheel = event.originalEvent as WheelEvent
          zoomTowards(event.screen, Math.exp(-wheel.deltaY * WHEEL_SENSITIVITY))
          return 'handled'
        },
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-zoom.keyboard',
        // 键盘事件不参与 target 阶段，用默认 bubble 即可
        when: (event) =>
          event.type === 'keydown' && (event.modifiers.ctrl || event.modifiers.meta),
        handle: (event) => {
          if (event.type !== 'keydown') return 'pass'

          // '+' 在多数键盘上需 Shift，浏览器的 key 可能是 '=' 或 '+'，两个都收
          if (event.key === '=' || event.key === '+') {
            event.preventDefault()
            zoomCenter(STEP)
            return 'handled'
          }
          if (event.key === '-') {
            event.preventDefault()
            zoomCenter(1 / STEP)
            return 'handled'
          }
          if (event.key === '0') {
            event.preventDefault()
            resetZoom()
            return 'handled'
          }
          return 'pass'
        },
      }),
    )

    ctx.effect(() =>
      ctx.command.register({
        id: 'canvas.zoomIn',
        title: '放大画布',
        run: () => zoomCenter(STEP),
      }),
    )
    ctx.effect(() =>
      ctx.command.register({
        id: 'canvas.zoomOut',
        title: '缩小画布',
        run: () => zoomCenter(1 / STEP),
      }),
    )
    ctx.effect(() =>
      ctx.command.register({
        id: 'canvas.zoomReset',
        title: '缩放 100%',
        run: () => resetZoom(),
      }),
    )
    ctx.effect(() =>
      ctx.command.register({
        id: 'canvas.zoomFit',
        title: '适应画布',
        // 显式传 64 屏幕像素留白，比视口 fit 的默认 40 更宽
        run: () => canvas.viewport.fit(canvas.scene.getRootBounds(), 64),
      }),
    )

    /**
     * 缩放到选区。
     *
     * 选中集里的节点可能还没登记几何（隐藏节点、刚插入未同步），取不到包围盒时
     * 退回适应整张画布，命令点下去永远有可见结果而不是什么都不做。
     */
    ctx.effect(() =>
      ctx.command.register({
        id: 'canvas.zoomToSelection',
        title: '缩放到选中节点',
        enabled: () => canvas.selection.ids.length > 0,
        run: () => {
          const bounds = canvas.scene.getBoundsOf(canvas.selection.ids)
          canvas.viewport.fit(bounds ?? canvas.scene.getRootBounds(), 40)
        },
      }),
    )

    const keybindingService: KeybindingService | undefined = ctx.keybinding
    if (keybindingService) {
      ctx.effect(() =>
        keybindingService.register({
          id: 'canvas-zoom.zoomToSelection',
          key: 'Mod+Shift+1',
          command: 'canvas.zoomToSelection',
        }),
      )
    }
  },
})
