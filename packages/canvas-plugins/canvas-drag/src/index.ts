import type { CanvasTransaction, SchemaPatch, SnapService } from '@lc/contracts'
import { defineCanvasPlugin, transformableIds } from '@lc/contracts'
import { normalizeRect } from '@lc/canvas'
import type { Rect } from '@lc/schema'
import { DRAG_BADGE_LABEL, DRAG_BADGE_SETTING } from './constants'
import { collectSubtree, createNodeLayoutPatch } from '@lc/schema'

export { manifest } from './manifest'

/**
 * 起拖所需的最小屏幕位移，与交互管线的 click 阈值同量级：
 * 低于它的抖动不写 patch，避免一次误点产生一条「移动 1px」的历史。
 */
const DRAG_THRESHOLD_PX = 3

/**
 * 节点拖拽插件。
 *
 * - 按住已选中节点拖动：一次事务提交、一条历史
 * - 拖动容器时整棵子树一起平移（子级 rect 是世界坐标，不会随父级自动跟随）
 * - 按住 Alt 临时禁用吸附
 * - 位移未超过阈值时不写 patch，避免误提交 1px 移动
 */
export default defineCanvasPlugin({
  name: 'canvas-drag',
  inject: { required: ['canvas', 'document'], optional: ['snap'] },

  apply(ctx) {
    const canvas = ctx.canvas
    const document = ctx.document
    const snap = ctx.snap

    ctx.effect(() =>
      canvas.settings.register<Rect | null>({
        id: DRAG_BADGE_SETTING,
        title: DRAG_BADGE_LABEL,
        scope: 'document',
        schema: {},
        default: null,
      }),
    )

    ctx.effect(() =>
      canvas.layers.register({
        id: 'canvas-drag.badge',
        band: 'preview',
        pointerEvents: 'none',
        // 懒加载：覆盖层依赖 Vue，静态引入会让 Node 侧的插件单测解析不了 .vue
        load: () => import('./overlay'),
      }),
    )

    /**
     * 取视口对应的世界矩形，作为吸附候选的裁剪范围。
     *
     * 只换算左上、右下两角，视口 rotation 为 0 时准确；旋转后得到的是偏小的
     * AABB，可能裁掉本应可见的候选，因此吸附在旋转视图下按粗筛理解。
     */
    function viewportWorldRect(): Rect {
      const topLeft = canvas.viewport.screenToWorld({ x: 0, y: 0 })
      const bottomRight = canvas.viewport.screenToWorld({
        x: canvas.viewport.size.width,
        y: canvas.viewport.size.height,
      })
      return normalizeRect(topLeft, bottomRight)
    }

    /**
     * 用空 rects 触发一次解析，把 lastResult 复位成无结果。
     *
     * 吸附服务没有显式的 clear 入口，靠 `rects.length === 0` 的短路分支清空
     * 缓存并广播变化，让覆盖层撤掉残留辅助线。
     */
    function clearSnap(service: SnapService, ids: readonly string[]): void {
      service.resolve({
        rects: [],
        zoom: canvas.viewport.state.zoom,
        viewportRect: viewportWorldRect(),
        movingIds: ids,
      })
    }

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-drag.move',
        phase: 'bubble',
        // 低于 canvas-selection(70)：选中集要先更新，本插件才能读到最新一组；
        // 高于手柄类以外的普通冒泡处理器
        priority: 50,
        when: (event) =>
          event.type === 'pointerdown' && event.buttons === 1 && Boolean(event.targetNodeId),
        handle: (event) => {
          if (event.type !== 'pointerdown' || !event.targetNodeId) return 'pass'

          // 按下已选中节点 → 整组一起拖；按下未选中节点 → 只拖它自己
          const group = canvas.selection.ids.includes(event.targetNodeId)
            ? canvas.selection.ids
            : [event.targetNodeId]
          // 命中测试已经挡住了锁定节点，这里再过滤一次：图层树可以把锁定节点
          // 放进取景框，整组拖拽时必须让它留在原地
          const roots = transformableIds(group, document.model.schema)

          // rect 是世界坐标，渲染子级时按父级原点补偿，所以子级不会随父级 rect
          // 自动平移；拖动容器必须把整棵子树一起算进来，否则父级移动后子级留在原地
          const ids = [...collectSubtree(document.model.schema, roots)]

          // 起始 rect 快照：每帧位移都相对按下时刻计算，避免逐帧累加产生浮点漂移。
          // 隐藏节点不登记场景，回落到 schema 里的 rect，保证重新显示后仍在原位
          const starts = new Map<string, Rect>()
          for (const id of ids) {
            const rect =
              canvas.scene.getBounds(id) ?? document.model.schema.nodes[id]?.layout?.rect
            if (rect) starts.set(id, rect)
          }
          if (starts.size === 0) return 'pass'

          // 标注只跟主节点：多选时整组位置与组框左上角重合，显示单个更贴近手感
          const primary = [...starts.entries()][0]

          // 吸附只以被直接拖动的节点为基准：整棵子树刚性平移，用后代边参与候选
          // 只会引入无关的吸附点
          const anchors = roots
            .map((id) => starts.get(id))
            .filter((rect): rect is Rect => rect !== undefined)

          let transaction: CanvasTransaction
          try {
            transaction = canvas.transaction.begin({ label: '移动节点', owner: 'canvas-drag' })
          } catch {
            // 已有其他手势事务（如缩放手柄），让位
            return 'pass'
          }

          const startWorld = event.world
          const startScreen = event.screen
          let started = false

          ctx.effect(() =>
            canvas.interaction.beginGesture({
              onMove: (move) => {
                // 阈值只在起拖前判定一次；起拖后即使回拉到起点也继续跟随
                if (!started) {
                  const moved = Math.hypot(
                    move.screen.x - startScreen.x,
                    move.screen.y - startScreen.y,
                  )
                  if (moved < DRAG_THRESHOLD_PX) return
                  started = true
                }

                let dx = move.world.x - startWorld.x
                let dy = move.world.y - startWorld.y

                // 吸附用「已位移」的矩形做候选比对，命中的 delta 再叠加到最终位移
                const movedRects = anchors.map((rect) => ({
                  ...rect,
                  x: rect.x + dx,
                  y: rect.y + dy,
                }))

                if (snap) {
                  // Alt 是临时禁用吸附：不仅要跳过计算，还要撤掉上一帧残留的辅助线
                  if (move.modifiers.alt) {
                    clearSnap(snap, ids)
                  } else {
                    const result = snap.resolve({
                      rects: movedRects,
                      zoom: canvas.viewport.state.zoom,
                      viewportRect: viewportWorldRect(),
                      movingIds: ids,
                    })
                    dx += result.delta.x
                    dy += result.delta.y
                  }
                }

                // 整块 rect 一次 replace，而不是 x / y 两条 path：事务按 path 去重，
                // 合并成一条能天然保证 x、y 来自同一帧
                const patches: SchemaPatch[] = [...starts.entries()].flatMap(([id, rect]) =>
                  createNodeLayoutPatch(id, {
                    rect: { ...rect, x: rect.x + dx, y: rect.y + dy },
                  }),
                )
                transaction.preview(patches)

                const [, primaryRect] = primary
                canvas.settings.set<Rect | null>(DRAG_BADGE_SETTING, {
                  ...primaryRect,
                  x: primaryRect.x + dx,
                  y: primaryRect.y + dy,
                })
              },

              // commit=false 来自 Esc 或 pointercancel：撤销预览并清掉辅助线
              onFinish: (commit) => {
                if (snap) clearSnap(snap, ids)
                canvas.settings.set<Rect | null>(DRAG_BADGE_SETTING, null)
                if (commit) transaction.commit()
                else transaction.cancel()
              },
            }),
          )

          // handled 在管线里是跨阶段消费：本次按下不会再进入后续处理器
          return 'handled'
        },
      }),
    )
  },
})
