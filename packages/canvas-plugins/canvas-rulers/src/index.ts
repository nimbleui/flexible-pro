import type { SnapService } from '@lc/contracts'
import { defineCanvasPlugin } from '@lc/contracts'
import {
  EMPTY_GUIDES,
  GUIDE_DRAFT_LABEL,
  GUIDE_DRAFT_SETTING,
  RULER_HANDLE,
  USER_GUIDES_LABEL,
  USER_GUIDES_SETTING,
  addGuide,
  guideCandidates,
  moveGuide,
  parseGuideHandleId,
  removeGuide,
} from './guides'
import type { GuideAxis, GuideDraft, UserGuides } from './guides'
import RulersOverlay from './overlay'

export { manifest } from './manifest'

/** 按下标尺后至少要拖出这么远才建线：单纯的点击表示「看一下标尺」，不该留下参考线 */
const CREATE_THRESHOLD_PX = 6

const RULER_HANDLES: readonly string[] = [RULER_HANDLE.horizontal, RULER_HANDLE.vertical]

/**
 * 标尺与用户参考线插件。
 *
 * 参考线存在画布设置里（scope=document），属于设计器会话态而不是文档数据：
 * schema 里没有承载它的字段，写进 schema 会让「导出给运行时的页面」背上编辑器负担。
 * 因此切换文档后参考线不保留，撤销/重做也不会碰到它们。
 *
 * 三条手势共用同一套手柄 id 约定（覆盖层渲染、处理器解析）：
 * - `ruler-h` / `ruler-v`：从标尺拖出一条新参考线
 * - `guide-h-<i>` / `guide-v-<i>`：拖动已有参考线，双击删除
 */
export default defineCanvasPlugin({
  name: 'canvas-rulers',
  inject: { required: ['canvas'], optional: ['snap'] },

  apply(ctx) {
    const canvas = ctx.canvas
    const snap = ctx.snap

    const readGuides = (): UserGuides =>
      canvas.settings.get<UserGuides>(USER_GUIDES_SETTING) ?? EMPTY_GUIDES

    const writeGuides = (guides: UserGuides): void => {
      canvas.settings.set(USER_GUIDES_SETTING, guides)
      canvas.scheduler.invalidateViewport()
    }

    const writeDraft = (draft: GuideDraft | null): void => {
      canvas.settings.set<GuideDraft | null>(GUIDE_DRAFT_SETTING, draft)
      canvas.scheduler.invalidateViewport()
    }

    ctx.effect(() =>
      canvas.settings.register<UserGuides>({
        id: USER_GUIDES_SETTING,
        title: USER_GUIDES_LABEL,
        scope: 'document',
        schema: {},
        default: EMPTY_GUIDES,
      }),
    )

    ctx.effect(() =>
      canvas.settings.register<GuideDraft | null>({
        id: GUIDE_DRAFT_SETTING,
        title: GUIDE_DRAFT_LABEL,
        scope: 'document',
        schema: {},
        default: null,
      }),
    )

    ctx.effect(() =>
      canvas.layers.register({
        id: 'canvas-rulers.overlay',
        band: 'hud',
        // 标尺贴在 hud 底部：小地图与右键菜单要压在标尺之上
        zIndex: 1,
        // children：只有标尺条和参考线本身接收指针，其余区域完全穿透
        pointerEvents: 'children',
        load: () => Promise.resolve({ default: RulersOverlay }),
      }),
    )

    if (snap) {
      ctx.effect(() =>
        snap.registerProvider({
          id: 'canvas-rulers.guides',
          getCandidates: (context) => guideCandidates(readGuides(), context),
        }),
      )
    }

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-rulers.create',
        phase: 'target',
        priority: 120,
        when: (event) =>
          event.type === 'pointerdown' &&
          event.buttons === 1 &&
          RULER_HANDLES.includes(event.targetHandleId ?? ''),
        handle: (event) => {
          if (event.type !== 'pointerdown' || !event.targetHandleId) return 'pass'

          const axis: GuideAxis =
            event.targetHandleId === RULER_HANDLE.horizontal ? 'horizontal' : 'vertical'
          const start = event.screen
          let draft: GuideDraft | null = null

          ctx.effect(() =>
            canvas.interaction.beginGesture({
              onMove: (move) => {
                const travelled =
                  Math.abs(move.screen.x - start.x) + Math.abs(move.screen.y - start.y)
                if (travelled < CREATE_THRESHOLD_PX) return

                draft = { axis, value: axis === 'horizontal' ? move.world.y : move.world.x }
                writeDraft(draft)
              },
              onFinish: (commit) => {
                // Esc 或指针取消：草稿消失，文档不留痕
                if (commit && draft) {
                  const created = draft
                  writeGuides(addGuide(readGuides(), created.axis, created.value))
                }
                writeDraft(null)
              },
            }),
          )

          // 手柄手势独占：标尺拖动不该同时触发框选或节点拖拽
          return 'stop'
        },
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-rulers.move',
        phase: 'target',
        priority: 120,
        when: (event) =>
          event.type === 'pointerdown' &&
          event.buttons === 1 &&
          parseGuideHandleId(event.targetHandleId ?? '') !== undefined,
        handle: (event) => {
          if (event.type !== 'pointerdown') return 'pass'
          const target = parseGuideHandleId(event.targetHandleId ?? '')
          if (!target) return 'pass'

          const original = readGuides()[target.axis][target.index]
          if (original === undefined) return 'pass'

          ctx.effect(() =>
            canvas.interaction.beginGesture({
              onMove: (move) => {
                const value = target.axis === 'horizontal' ? move.world.y : move.world.x
                writeGuides(moveGuide(readGuides(), target.axis, target.index, value))
              },
              onFinish: (commit) => {
                if (!commit) {
                  writeGuides(moveGuide(readGuides(), target.axis, target.index, original))
                }
              },
            }),
          )

          return 'stop'
        },
      }),
    )

    ctx.effect(() =>
      canvas.interaction.register({
        id: 'canvas-rulers.delete',
        phase: 'bubble',
        priority: 120,
        // 管线的 dblclick 发生在第二次 pointerup 之后，命中信息已被清空，
        // 只能从原生事件的 DOM 目标反查手柄 id
        when: (event) =>
          event.type === 'dblclick' && guideHandleFrom(event.originalEvent) !== undefined,
        handle: (event) => {
          const target = parseGuideHandleId(guideHandleFrom(event.originalEvent) ?? '')
          if (!target) return 'pass'

          writeGuides(removeGuide(readGuides(), target.axis, target.index))
          return 'handled'
        },
      }),
    )
  },
})

/** 从 dblclick 的 DOM 目标向上找参考线手柄 id；不是参考线时返回 undefined */
function guideHandleFrom(originalEvent: Event): string | undefined {
  const element = originalEvent.target
  if (!(element instanceof Element)) return undefined
  return (
    element.closest('[data-handle-id^="guide-"]')?.getAttribute('data-handle-id') ?? undefined
  )
}
