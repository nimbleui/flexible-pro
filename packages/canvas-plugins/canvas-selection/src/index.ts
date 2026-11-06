import type { CanvasModifiers, Point } from '@lc/contracts'
import { defineCanvasPlugin } from '@lc/contracts'
import { normalizeRect } from '@lc/canvas'
import type { Rect } from '@lc/schema'
import { HOVER_SETTING, MARQUEE_SETTING } from './constants'
import { nextInCycle, outermostOf, selectableParent, stackAt } from './hierarchy'

export { manifest } from './manifest'

/** 设置面板里的展示名；与设置 id 分开，改文案不影响订阅 */
const MARQUEE_LABEL = '框选矩形'
const HOVER_LABEL = '悬停高亮'

/** Alt 连点判定为「同一处」的屏幕半径；超过它视为换了目标，循环重新开始 */
const CYCLE_RESET_PX = 4

/**
 * Alt+连点的循环状态：锚点必须停在原地，换位置就重新从最上层开始。
 *
 * 只在插件实例内存活，其它选中方式（Ctrl / Shift / 空白处）都会把它清空。
 */
interface AltCycle {
  /** 上次点击的屏幕坐标，作为循环锚点（CSS 像素，相对舞台原点） */
  screen: Point
  /** 本次已展示到的节点 id，下次点击从它的下一层继续 */
  current: string
}

/** 加选 / 减选修饰键：Shift、Ctrl、⌘ 同义 */
function additiveOf(modifiers: CanvasModifiers): boolean {
  return modifiers.shift || modifiers.ctrl || modifiers.meta
}

/**
 * 选择插件。
 *
 * 命中顺序由绘制顺序决定（内层优先），指针语义：
 * - 单击：最上层节点；空白处清空；按在画幅背景上且没有拖出位移 → 选中页面本身
 * - Shift+单击：加选 / 减选命中的节点
 * - Ctrl/⌘+单击：直穿到底，加选 / 减选该点最底层的节点
 * - Alt+单击：在重叠节点间循环，重复点击依次向下一层
 * - 拖动空白：框选；按住 Shift/Ctrl/⌘ 拖动：结果并入当前选中集
 * - 双击命中的节点 / Esc：选中主选节点的父级（向上选择，自动跳过隐藏与锁定祖先）
 *
 * 画幅根（`canvas.nodeFlags.root`）覆盖整页，按在它身上如果走普通节点分支，就会变成
 * 「按哪儿都拖得动、框不动」：按下即选中根、拖动搬走整页。所以按下根一律按空白处理，
 * 拖动用来框选，选中页面交给抬手后管线合成的 click（位移在阈值内才会发）。
 *
 * 悬停高亮跟随指针显示「单击会选中谁」，锁定与隐藏节点天然不参与（命中测试已过滤）。
 */
export default defineCanvasPlugin({
  name: 'canvas-selection',
  inject: ['canvas', 'document'],

  apply(ctx) {
    const canvas = ctx.canvas
    const document = ctx.document

    /** 上一次写入高亮的节点；undefined 表示当前没有高亮 */
    let hovered: string | undefined

    /** Alt+连点的循环状态；null 表示当前不在循环里 */
    let cycle: AltCycle | null = null

    function setHover(next: string | undefined): void {
      if (next === hovered) return
      hovered = next
      canvas.settings.set<string | null>(HOVER_SETTING, next ?? null)
    }

    /** 父级选择：命中节点或主选节点向上走一层，跳过隐藏/锁定祖先 */
    function selectParent(nodeId: string): boolean {
      const parent = selectableParent(document.model.schema, nodeId, canvas.nodeFlags)
      if (!parent) return false
      canvas.selection.set([parent])
      cycle = null
      return true
    }

    ctx.effect(() =>
      canvas.settings.register<Rect | null>({
        id: MARQUEE_SETTING,
        title: MARQUEE_LABEL,
        scope: 'document',
        schema: {},
        default: null,
      }),
    )

    ctx.effect(() =>
      canvas.settings.register<string | null>({
        id: HOVER_SETTING,
        title: HOVER_LABEL,
        scope: 'document',
        schema: {},
        default: null,
      }),
    )

    // 悬停、选中框与框选矩形画在同一层：同一份订阅、同一帧重绘，不额外占一个图层
    ctx.effect(() =>
      canvas.layers.register({
        id: 'canvas-selection.overlay',
        band: 'selection',
        pointerEvents: 'none',
        // 懒加载：覆盖层依赖 Vue，静态引入会让 Node 侧的插件单测解析不了 .vue
        load: () => import('./overlay'),
      }),
    )

    // 悬停高亮：只在没有按键按下时跟踪，拖拽/框选期间保持清空
    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-selection.hover',
        priority: 10,
        when: (event) => event.type === 'pointermove',
        handle: (event) => {
          if (event.type !== 'pointermove') return 'pass'
          setHover(canvas.hitTest.at(event.screen))
          return 'pass'
        },
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-selection.hover-reset',
        priority: 10,
        when: (event) => event.type === 'pointerleave' || event.type === 'wheel',
        handle: () => {
          setHover(undefined)
          return 'pass'
        },
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-selection.click',
        priority: 65,
        when: (event) =>
          event.type === 'click' && Boolean(event.targetNodeId) && !additiveOf(event.modifiers),
        handle: (event) => {
          if (event.type !== 'click' || !event.targetNodeId) return 'pass'
          // 单击（无拖动）收敛为该节点：拖拽场景由管线抑制 click，走不到这里。
          // 按下画幅根时不预选中（见 pointer 处理器），「点页面背景 = 选中页面」
          // 就发生在这次 click 上；选中服务对同集合去重，重复 set 不会多通知。
          canvas.selection.set([event.targetNodeId])
          return 'pass'
        },
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-selection.pointer',
        phase: 'bubble',
        // 必须早于 canvas-drag：先更新选中集，再让拖拽读取最新选中
        priority: 70,
        when: (event) =>
          event.type === 'pointerdown' && event.buttons === 1 && !event.targetHandleId,
        handle: (event) => {
          if (event.type !== 'pointerdown') return 'pass'
          setHover(undefined)

          // 画幅根覆盖整页，按下它等同于按下空白：不预选中、不交给拖拽插件，
          // 位移交给框选；零位移抬手时由管线合成的 click 负责选中页面
          const target =
            event.targetNodeId && event.targetNodeId !== canvas.nodeFlags.root
              ? event.targetNodeId
              : undefined

          if (target) {
            // Alt：在重叠节点里循环；连点在原地才继续，换位置重新从最上层开始
            if (event.modifiers.alt) {
              let start = canvas.selection.primary ?? target
              if (
                cycle &&
                Math.hypot(cycle.screen.x - event.screen.x, cycle.screen.y - event.screen.y) <=
                  CYCLE_RESET_PX
              ) {
                start = cycle.current
              }
              const next = nextInCycle(stackAt(canvas.hitTest, event.screen), start)
              if (next) {
                canvas.selection.set([next])
                cycle = { screen: event.screen, current: next }
              }
              return 'handled'
            }

            // Ctrl/⌘：直穿到底，切换该点最底层节点的选中状态
            if (event.modifiers.ctrl || event.modifiers.meta) {
              const outer = outermostOf(stackAt(canvas.hitTest, event.screen))
              if (outer) canvas.selection.toggle(outer)
              cycle = null
              return 'handled'
            }

            if (event.modifiers.shift) {
              canvas.selection.toggle(target)
              cycle = null
              return 'handled'
            }

            if (!canvas.selection.ids.includes(target)) {
              canvas.selection.set([target])
              cycle = null
            }
            // pass：拖拽插件需要收到同一次 pointerdown
            return 'pass'
          }

          // 空白处与画幅背景：加选修饰键下保留原选中集，框选结果并入而不是替换
          const base = additiveOf(event.modifiers) ? [...canvas.selection.ids] : []
          if (base.length === 0) canvas.selection.clear()
          cycle = null

          const start = event.world
          /**
           * 框选实时更新：世界矩形写进设置供覆盖层绘制，命中判定必须换回屏幕矩形
           * （hitTest.inRect 收的是屏幕坐标）。
           *
           * 世界 AABB 与屏幕 AABB 不等价，因此这里重新换算而不是复用 marquee；
           * 每帧写设置会触发一次设置订阅通知，覆盖层据此重绘。
           *
           * @param world 指针当前世界坐标（世界单位）；与起点 start 张成框选矩形
           */
          const applyMarquee = (world: Point): void => {
            const marquee = normalizeRect(start, world)
            canvas.settings.set(MARQUEE_SETTING, marquee)

            const topLeft = canvas.viewport.worldToScreen({ x: marquee.x, y: marquee.y })
            const bottomRight = canvas.viewport.worldToScreen({
              x: marquee.x + marquee.width,
              y: marquee.y + marquee.height,
            })
            const screenRect = normalizeRect(topLeft, bottomRight)
            const hits = canvas.hitTest.inRect(screenRect)
            canvas.selection.set([...new Set([...base, ...hits])])
          }

          ctx.effect(() =>
            canvas.interaction.beginGesture({
              onMove: (move) => applyMarquee(move.world),
              // 抬手清空临时矩形，覆盖层随即停止绘制；选中结果已经落到 selection 服务
              onFinish: () => canvas.settings.set(MARQUEE_SETTING, null),
            }),
          )

          return 'handled'
        },
      }),
    )

    // 双击向上：命中节点的父级；单击已经先选中了内层，双击正好往上退一层
    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-selection.dblclick',
        priority: 60,
        when: (event) => event.type === 'dblclick',
        handle: (event) => {
          if (event.type !== 'dblclick') return 'pass'
          const hit = canvas.hitTest.at(event.screen)
          return hit && selectParent(hit) ? 'handled' : 'pass'
        },
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-selection.escape',
        priority: 80,
        when: (event) => event.type === 'keydown' && event.key === 'Escape',
        handle: (event) => {
          const primary = canvas.selection.primary
          if (!primary) return 'pass'
          if (!selectParent(primary)) return 'pass'
          event.preventDefault()
          return 'handled'
        },
      }),
    )
  },
})
