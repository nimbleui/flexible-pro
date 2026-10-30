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
} {
  let handler: InteractionHandler | undefined
  let gesture: GestureCallbacks | undefined
  const previews: SchemaPatch[] = []

  const transaction: CanvasTransaction = {
    closed: false,
    preview(patches) {
      previews.push(...patches)
    },
    commit() {},
    cancel() {},
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
        return { dispose() {} }
      },
    },
    scene: {
      getBounds(nodeId: string) {
        return options.bounds?.get(nodeId) ?? schema.nodes[nodeId]?.layout?.rect
      },
    },
    selection: { ids: options.selection },
    transaction: {
      begin() {
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
    effect<T>(factory: () => T): T {
      return factory()
    },
  } as unknown as CanvasContext

  dragPlugin.apply(context, undefined)

  return {
    context,
    handler: handler as InteractionHandler,
    gesture: () => gesture as GestureCallbacks,
    previews,
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
})
