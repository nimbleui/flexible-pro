import { describe, expect, it } from 'vitest'
import type {
  CanvasContext,
  CanvasPointerEvent,
  CanvasTransaction,
  GestureCallbacks,
  InteractionHandler,
} from '@lc/contracts'
import type { PageSchema, Rect, SchemaPatch } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import dragPlugin from '../src/index'

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height }
}

function createSchema(): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        componentName: 'Group',
        children: ['card', 'sticker'],
        layout: { mode: 'absolute', rect: rect(0, 0, 400, 300) },
      },
      card: {
        id: 'card',
        componentName: 'Group',
        children: ['title', 'hiddenNote'],
        layout: { mode: 'absolute', rect: rect(40, 40, 200, 120) },
      },
      title: {
        id: 'title',
        componentName: 'Text',
        layout: { mode: 'absolute', rect: rect(60, 60, 120, 24) },
      },
      hiddenNote: {
        id: 'hiddenNote',
        componentName: 'Text',
        hidden: true,
        layout: { mode: 'absolute', rect: rect(60, 100, 120, 24) },
      },
      sticker: {
        id: 'sticker',
        componentName: 'Box',
        children: ['stickerText'],
        layout: { mode: 'absolute', rect: rect(280, 40, 80, 40) },
      },
      stickerText: {
        id: 'stickerText',
        componentName: 'Text',
        layout: { mode: 'absolute', rect: rect(290, 50, 60, 20) },
      },
    },
    components: [],
  }
}

/** 构造只覆盖拖拽路径所需的上下文替身；契约层其余成员不参与本插件逻辑 */
function createContext(
  schema: PageSchema,
  options: { selection: readonly string[]; bounds?: ReadonlyMap<string, Rect> },
): {
  context: CanvasContext
  handler: InteractionHandler
  gesture: () => GestureCallbacks
  previews: SchemaPatch[]
  /** 每次 transaction.begin 的历史标签，用于断言「压根没起手势」 */
  began: string[]
  /** 模拟真实管线的收尾：先摘掉活动手势，再回调 onFinish */
  finishGesture: (commit: boolean) => void
  /** 交给 ctx.effect 托管的副作用条数，即 EffectScope 的待回收记录数 */
  registered: () => number
  /** 模拟插件作用域销毁：逆序回收全部登记的副作用 */
  disposeScope: () => void
  commits: () => number
  cancels: () => number
} {
  let handler: InteractionHandler | undefined
  let gesture: GestureCallbacks | undefined
  /** 活动手势与它的收尾状态：句柄被重复 dispose 时不得再回调一次 onFinish */
  let active: { callbacks: GestureCallbacks; finished: boolean } | null = null
  const registered: Array<{ dispose(): void }> = []
  const previews: SchemaPatch[] = []
  const began: string[] = []
  let commitCount = 0
  let cancelCount = 0

  const transaction: CanvasTransaction = {
    closed: false,
    preview(patches) {
      previews.push(...patches)
    },
    commit() {
      commitCount += 1
    },
    cancel() {
      cancelCount += 1
    },
  }

  /** 与管线 `finishGesture` 同规则：先置空再回调，onFinish 里才能紧接着起新手势 */
  function finishGesture(commit: boolean): void {
    const current = active
    if (!current) return
    current.finished = true
    active = null
    gesture = undefined
    current.callbacks.onFinish(commit)
  }

  const canvas = {
    // 插件在 apply 里注册位置标注的设置与覆盖层，测试只关心手势，因此给空实现
    settings: {
      register: () => ({ dispose() {} }),
      get: () => null,
      set: () => undefined,
      onDidChange: () => ({ dispose() {} }),
    },
    layers: {
      register: () => ({ dispose() {} }),
    },
    interaction: {
      register(next: InteractionHandler) {
        handler = next
        return { dispose() {} }
      },
      beginGesture(callbacks: GestureCallbacks) {
        gesture = callbacks
        const token = { callbacks, finished: false }
        active = token
        return {
          dispose() {
            if (token.finished || active !== token) return
            finishGesture(false)
          },
        }
      },
    },
    scene: {
      getBounds(nodeId: string) {
        return options.bounds?.get(nodeId) ?? schema.nodes[nodeId]?.layout?.rect
      },
    },
    selection: { ids: options.selection },
    transaction: {
      begin(optionsForBegin: { label: string }) {
        began.push(optionsForBegin.label)
        return transaction
      },
    },
    viewport: {
      state: { zoom: 1 },
      size: { width: 0, height: 0 },
      screenToWorld: (point: { x: number; y: number }) => point,
    },
  }

  const context = {
    canvas,
    document: { model: { schema } },
    snap: undefined,
    // 与真实 EffectScope 同构：每次登记追加一条待回收记录，只有作用域销毁才回收
    effect<T extends { dispose(): void }>(factory: () => T): T {
      const item = factory()
      registered.push(item)
      return item
    },
  } as unknown as CanvasContext

  dragPlugin.apply(context, undefined)

  return {
    context,
    handler: handler as InteractionHandler,
    gesture: () => gesture as GestureCallbacks,
    previews,
    began,
    finishGesture,
    registered: () => registered.length,
    disposeScope: () => {
      for (let index = registered.length - 1; index >= 0; index -= 1)
        registered[index]?.dispose()
      registered.length = 0
    },
    commits: () => commitCount,
    cancels: () => cancelCount,
  }
}

function pointerEvent(overrides: Partial<CanvasPointerEvent>): CanvasPointerEvent {
  return {
    type: 'pointerdown',
    phase: 'bubble',
    modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    screen: { x: 0, y: 0 },
    world: { x: 0, y: 0 },
    delta: { x: 0, y: 0 },
    buttons: 1,
    pointerId: 1,
    originalEvent: {} as PointerEvent,
    preventDefault() {},
    stopPropagation() {},
    ...overrides,
  }
}

function movedRects(patches: readonly SchemaPatch[]): Map<string, Rect> {
  return new Map(patches.map((patch) => [patch.path, patch.value as Rect] as const))
}

describe('节点拖拽', () => {
  it('拖动容器时整棵子树一起平移', () => {
    const schema = createSchema()
    const { context, handler, gesture, previews } = createContext(schema, {
      // hiddenNote 隐藏后不登记场景，插件需要回落到 schema 里的世界矩形
      bounds: new Map([
        ['card', rect(40, 40, 200, 120)],
        ['title', rect(60, 60, 120, 24)],
        ['sticker', rect(280, 40, 80, 40)],
        ['stickerText', rect(290, 50, 60, 20)],
      ]),
      selection: ['card'],
    })

    handler.handle(
      pointerEvent({ targetNodeId: 'card', screen: { x: 50, y: 50 }, world: { x: 50, y: 50 } }),
      context,
    )
    gesture().onMove(
      pointerEvent({
        type: 'pointermove',
        screen: { x: 70, y: 90 },
        world: { x: 70, y: 90 },
      }),
    )

    expect(movedRects(previews)).toEqual(
      new Map([
        ['/nodes/card/layout/rect', rect(60, 80, 200, 120)],
        ['/nodes/title/layout/rect', rect(80, 100, 120, 24)],
        ['/nodes/hiddenNote/layout/rect', rect(80, 140, 120, 24)],
      ]),
    )
  })

  it('拖动叶子节点只移动自身', () => {
    const schema = createSchema()
    const { context, handler, gesture, previews } = createContext(schema, {
      selection: ['title'],
    })

    handler.handle(
      pointerEvent({
        targetNodeId: 'title',
        screen: { x: 60, y: 60 },
        world: { x: 60, y: 60 },
      }),
      context,
    )
    gesture().onMove(
      pointerEvent({
        type: 'pointermove',
        screen: { x: 72, y: 66 },
        world: { x: 72, y: 66 },
      }),
    )

    expect(movedRects(previews)).toEqual(
      new Map([['/nodes/title/layout/rect', rect(72, 66, 120, 24)]]),
    )
  })

  it('按下画幅根不进入拖拽手势', () => {
    const schema = createSchema()
    const { context, handler, previews, began } = createContext(schema, {
      selection: ['root'],
    })

    const result = handler.handle(
      pointerEvent({
        targetNodeId: 'root',
        screen: { x: 10, y: 10 },
        world: { x: 10, y: 10 },
      }),
      context,
    )

    // pass 而不是 handled：单击仍要落回选中根，让属性面板可编辑页面
    expect(result).toBe('pass')
    expect(began).toEqual([])
    expect(previews).toEqual([])
  })

  it('整组拖拽时画幅根留在原地', () => {
    const schema = createSchema()
    const { context, handler, gesture, previews } = createContext(schema, {
      selection: ['root', 'title'],
    })

    handler.handle(
      pointerEvent({
        targetNodeId: 'title',
        screen: { x: 60, y: 60 },
        world: { x: 60, y: 60 },
      }),
      context,
    )
    gesture().onMove(
      pointerEvent({
        type: 'pointermove',
        screen: { x: 80, y: 60 },
        world: { x: 80, y: 60 },
      }),
    )

    expect(movedRects(previews)).toEqual(
      new Map([['/nodes/title/layout/rect', rect(80, 60, 120, 24)]]),
    )
  })

  describe('手势登记的生命周期', () => {
    /** 起一场真实的手势：按下 → 越过阈值位移 → 抬手提交 */
    function dragOnce(
      harness: ReturnType<typeof createContext>,
      context: CanvasContext,
      nodeId: string,
    ): void {
      harness.handler.handle(
        pointerEvent({
          targetNodeId: nodeId,
          screen: { x: 60, y: 60 },
          world: { x: 60, y: 60 },
        }),
        context,
      )
      harness.gesture().onMove(
        pointerEvent({
          type: 'pointermove',
          screen: { x: 90, y: 90 },
          world: { x: 90, y: 90 },
        }),
      )
      harness.finishGesture(true)
    }

    it('反复拖拽不增加 EffectScope 的登记条数', () => {
      const schema = createSchema()
      const harness = createContext(schema, { selection: ['title'] })
      const baseline = harness.registered()

      for (let index = 0; index < 200; index += 1) dragOnce(harness, harness.context, 'title')

      // 逐次 ctx.effect(() => beginGesture(...)) 时这里是 baseline + 200：
      // EffectScope 只在插件卸载时回收，每次按下指针都会永久留下一条记录，
      // 其闭包还钉住手势前的文档快照
      expect(harness.registered()).toBe(baseline)
      expect(harness.commits()).toBe(200)
    })

    it('插件卸载时进行中的手势被取消并回退预览', () => {
      const schema = createSchema()
      const harness = createContext(schema, { selection: ['title'] })

      harness.handler.handle(
        pointerEvent({
          targetNodeId: 'title',
          screen: { x: 60, y: 60 },
          world: { x: 60, y: 60 },
        }),
        harness.context,
      )
      harness.gesture().onMove(
        pointerEvent({
          type: 'pointermove',
          screen: { x: 90, y: 90 },
          world: { x: 90, y: 90 },
        }),
      )
      harness.disposeScope()

      expect(harness.cancels()).toBe(1)
      expect(harness.commits()).toBe(0)
    })

    it('手势已收尾后卸载不再回调 onFinish', () => {
      const schema = createSchema()
      const harness = createContext(schema, { selection: ['title'] })

      dragOnce(harness, harness.context, 'title')
      expect(harness.commits()).toBe(1)

      // onFinish 已清空槽位：卸载时不该把手势再取消一遍，那会凭空多一条 cancel 记录
      harness.disposeScope()
      expect(harness.cancels()).toBe(0)
      expect(harness.commits()).toBe(1)
    })
  })
})
