import type {
  CanvasContext,
  CanvasPointerEvent,
  GestureCallbacks,
  InteractionHandler,
} from '@lc/contracts'
import type { NodeSchema, PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import { describe, expect, it } from 'vitest'
import selectionPlugin from '../src/index'
import { HOVER_SETTING, MARQUEE_SETTING } from '../src/constants'

function node(id: string, extra: Partial<NodeSchema> = {}): NodeSchema {
  return { id, componentName: 'Box', ...extra }
}

function createSchema(root: string): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: root,
    nodes: {
      [root]: node(root, { children: ['card'] }),
      card: node('card'),
    },
    components: [],
  }
}

interface Harness {
  handler: (id: string) => InteractionHandler
  gesture: () => GestureCallbacks
  setting: (id: string) => unknown
  selectionSets: string[][]
  clears: () => number
  currentIds: () => readonly string[]
  context: CanvasContext
}

/** 只覆盖选择插件所需的最小替身：命中结果、选中集、设置与手势都可被观察 */
function createContext(options: {
  root: string
  selection?: readonly string[]
  hits?: readonly string[]
}): Harness {
  let ids = [...(options.selection ?? [])]
  let cleared = 0
  let gesture: GestureCallbacks | undefined
  const handlers = new Map<string, InteractionHandler>()
  const settings = new Map<string, unknown>()
  const selectionSets: string[][] = []

  const canvas = {
    nodeFlags: { hidden: new Set<string>(), locked: new Set<string>(), root: options.root },
    selection: {
      get ids() {
        return ids
      },
      get primary() {
        return ids[ids.length - 1]
      },
      set: (next: readonly string[]) => {
        selectionSets.push([...next])
        ids = [...next]
      },
      clear: () => {
        cleared += 1
        ids = []
      },
      toggle: (id: string) => {
        ids = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
      },
    },
    hitTest: {
      at: () => options.root,
      inRect: () => [...(options.hits ?? [])],
      containerAt: () => undefined,
    },
    settings: {
      register: () => ({ dispose() {} }),
      get: (id: string) => settings.get(id),
      set: (id: string, value: unknown) => {
        settings.set(id, value)
      },
      onDidChange: () => ({ dispose() {} }),
    },
    layers: { register: () => ({ dispose() {} }) },
    interaction: {
      register(next: InteractionHandler) {
        handlers.set(next.id, next)
        return { dispose() {} }
      },
      beginGesture(callbacks: GestureCallbacks) {
        gesture = callbacks
        return { dispose() {} }
      },
    },
    viewport: {
      state: { zoom: 1 },
      size: { width: 0, height: 0 },
      screenToWorld: (point: { x: number; y: number }) => point,
      worldToScreen: (point: { x: number; y: number }) => point,
    },
  }

  const context = {
    canvas,
    document: { model: { schema: createSchema(options.root) } },
    effect<T>(factory: () => T): T {
      return factory()
    },
  } as unknown as CanvasContext

  selectionPlugin.apply(context, undefined)

  return {
    context,
    handler: (id: string) => {
      const registered = handlers.get(id)
      if (!registered) throw new Error(`处理器未注册：${id}`)
      return registered
    },
    gesture: () => gesture as GestureCallbacks,
    setting: (id: string) => settings.get(id),
    selectionSets,
    clears: () => cleared,
    currentIds: () => ids,
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

const POINTER = 'canvas-selection.pointer'
const CLICK = 'canvas-selection.click'

describe('按下画幅根', () => {
  it('不预选中根节点，把位移让给框选', () => {
    const harness = createContext({ root: 'board', selection: ['card'] })

    const result = harness
      .handler(POINTER)
      .handle(
        pointerEvent({
          targetNodeId: 'board',
          screen: { x: 20, y: 20 },
          world: { x: 20, y: 20 },
        }),
        harness.context,
      )

    expect(result).toBe('handled')
    expect(harness.selectionSets).toEqual([])
    expect(harness.clears()).toBe(1)
  })

  it('按下后拖动即框选命中的子节点', () => {
    const harness = createContext({ root: 'board', hits: ['card'] })

    harness
      .handler(POINTER)
      .handle(
        pointerEvent({
          targetNodeId: 'board',
          screen: { x: 10, y: 10 },
          world: { x: 10, y: 10 },
        }),
        harness.context,
      )
    harness
      .gesture()
      .onMove(
        pointerEvent({
          type: 'pointermove',
          screen: { x: 90, y: 90 },
          world: { x: 90, y: 90 },
        }),
      )

    expect(harness.setting(MARQUEE_SETTING)).toEqual({ x: 10, y: 10, width: 80, height: 80 })
    expect(harness.currentIds()).toEqual(['card'])

    harness.gesture().onFinish(true)
    expect(harness.setting(MARQUEE_SETTING)).toBeNull()
  })

  it('按住 Shift 按根拖动时并入原选中集', () => {
    const harness = createContext({ root: 'board', selection: ['card'], hits: ['board'] })

    harness.handler(POINTER).handle(
      pointerEvent({
        targetNodeId: 'board',
        modifiers: { alt: false, ctrl: false, meta: false, shift: true },
        screen: { x: 0, y: 0 },
        world: { x: 0, y: 0 },
      }),
      harness.context,
    )
    harness
      .gesture()
      .onMove(
        pointerEvent({
          type: 'pointermove',
          screen: { x: 50, y: 50 },
          world: { x: 50, y: 50 },
        }),
      )

    expect(harness.clears()).toBe(0)
    // 原选中集被保留并并入框选结果；命中集里含画幅根本身（inRect 不排斥它），
    // 由 P0 的变换闸门保证它待在原地
    expect(harness.currentIds()).toEqual(['card', 'board'])
  })

  it('零位移抬手后的 click 才把页面选进选中集', () => {
    const harness = createContext({ root: 'board' })

    harness
      .handler(POINTER)
      .handle(
        pointerEvent({
          targetNodeId: 'board',
          screen: { x: 30, y: 30 },
          world: { x: 30, y: 30 },
        }),
        harness.context,
      )
    harness
      .handler(CLICK)
      .handle(
        pointerEvent({ type: 'click', targetNodeId: 'board', screen: { x: 30, y: 30 } }),
        harness.context,
      )

    expect(harness.selectionSets).toEqual([['board']])
    expect(harness.setting(HOVER_SETTING)).toBeUndefined()
  })
})

describe('按下普通节点', () => {
  it('仍然按下即选中并让位给拖拽插件', () => {
    const harness = createContext({ root: 'board' })

    const result = harness
      .handler(POINTER)
      .handle(
        pointerEvent({
          targetNodeId: 'card',
          screen: { x: 40, y: 40 },
          world: { x: 40, y: 40 },
        }),
        harness.context,
      )

    expect(result).toBe('pass')
    expect(harness.currentIds()).toEqual(['card'])
  })

  it('多选里点谁就只剩谁', () => {
    const harness = createContext({ root: 'board', selection: ['card', 'board'] })

    harness
      .handler(CLICK)
      .handle(
        pointerEvent({ type: 'click', targetNodeId: 'card', screen: { x: 5, y: 5 } }),
        harness.context,
      )

    expect(harness.currentIds()).toEqual(['card'])
  })
})
