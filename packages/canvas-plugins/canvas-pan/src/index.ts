import { defineCanvasPlugin } from '@lc/contracts'

export { manifest } from './manifest'

/** PointerEvent.buttons 的中键位掩码（4），不是按钮序号 */
const MIDDLE_BUTTON = 4

/**
 * 画布平移插件。
 *
 * 三个入口：
 * - 按住空格 + 左键拖动（最高优先级，选择/拖拽让位）
 * - 中键拖动
 * - 普通滚轮 / 触控板双指滚动
 *
 * 所有移动只改视口，不写文档、不产生历史。
 */
export default defineCanvasPlugin({
  name: 'canvas-pan',
  inject: ['canvas'],

  apply(ctx) {
    const canvas = ctx.canvas

    /**
     * 空格按住状态。
     *
     * keydown / keyup 都来自舞台元素：按下空格后焦点被别处抢走会收不到 keyup，
     * 状态停在 true，需要再按一次空格才能复位。
     */
    let spaceHeld = false

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-pan.space',
        // capture + 最高优先级：空格状态必须先于任何按下被记录，
        // 否则同一次 pointerdown 读到的还是上一帧的空格状态
        phase: 'capture',
        priority: 1000,
        handle: (event) => {
          // 只记录空格状态，不消费事件，避免影响其他键盘快捷键
          if (event.type === 'keydown' && event.key === ' ') {
            spaceHeld = true

            // 阻止浏览器把空格交给聚焦元素（按钮会因空格被触发点击）
            event.preventDefault()
          }
          if (event.type === 'keyup' && event.key === ' ') {
            spaceHeld = false
          }
          return 'pass'
        },
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-pan.drag',
        phase: 'capture',
        // 高于冒泡阶段的选择(70)与拖拽(50)：空格或中键按下时二者都不应起拖
        priority: 80,
        when: (event) =>
          event.type === 'pointerdown' &&
          (spaceHeld || (event.buttons & MIDDLE_BUTTON) === MIDDLE_BUTTON),
        handle: (event) => {
          if (event.type !== 'pointerdown') return 'pass'
          event.preventDefault()

          // 逐帧增量平移：last 每帧前移，所以平移跟手而不是相对按下点累计
          let last = event.screen
          ctx.effect(() =>
            canvas.interaction.beginGesture({
              onMove: (move) => {
                canvas.viewport.panBy({
                  x: move.screen.x - last.x,
                  y: move.screen.y - last.y,
                })
                last = move.screen
              },
              // 平移不改文档，没有需要撤销的内容；Esc 只需停止跟随
              onFinish: () => {},
            }),
          )
          return 'handled'
        },
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-pan.wheel',
        // 低于 canvas-zoom(30)：带 Ctrl/⌘ 的滚轮由缩放先消费，这里只接普通滚动
        priority: 10,
        when: (event) =>
          event.type === 'wheel' && !event.modifiers.ctrl && !event.modifiers.meta,
        handle: (event) => {
          if (event.type !== 'wheel') return 'pass'

          // 管线 delta 恒为 0，滚动量取自原生事件；负号让内容跟随滚动方向移动。
          // 未按 wheel.deltaMode 换算单位，浏览器以行/页计数时平移量会偏小
          const wheel = event.originalEvent as WheelEvent
          event.preventDefault()
          canvas.viewport.panBy({ x: -wheel.deltaX, y: -wheel.deltaY })
          return 'handled'
        },
      }),
    )
  },
})
