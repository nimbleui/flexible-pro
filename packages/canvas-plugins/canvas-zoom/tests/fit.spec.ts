import type { CanvasContext, Command, Rect, Size } from '@lc/contracts'
import type { Disposable } from '@lc/kernel'
import { describe, expect, it } from 'vitest'
import zoomPlugin from '../src/index'

/** 「适应画布」命令与首帧适配共用的留白，断言里直接引用同一语义 */
const FIT_PADDING = 64

function rect(width: number, height: number): Rect {
  return { x: 0, y: 0, width, height }
}

/**
 * 只铺首帧适配会碰到的几片：视口尺寸与通知、场景根矩形、命令注册表。
 *
 * fit 不真的算缩放，只记录被调用了几次、参数是什么——这里要保护的是
 * 「什么时候允许动用户的视口」这条策略，不是 fitZoom 的算术（那边已有覆盖）。
 */
function createHarness(options: { size: Size; bounds: Rect }) {
  const state = { size: options.size, bounds: options.bounds }
  const listeners: Array<() => void> = []
  const fitCalls: Array<{ rect: Rect; padding?: number }> = []

  const context = {
    canvas: {
      viewport: {
        get size(): Size {
          return state.size
        },
        state: { x: 0, y: 0, zoom: 1, rotation: 0 },
        onDidChange(listener: () => void): Disposable {
          listeners.push(listener)
          return { dispose: () => {} }
        },
        fit(rectArg: Rect, padding?: number): void {
          fitCalls.push({ rect: rectArg, padding })
        },
      },
      scene: {
        getRootBounds(): Rect {
          return state.bounds
        },
      },
      selection: { ids: [] as readonly string[] },
      // apply 会登记滚轮与键盘两个交互入口，这里只需要它们不抛
      interaction: {
        register: (): Disposable => ({ dispose: () => {} }),
      },
    },
    command: {
      register: (_next: Command): Disposable => ({ dispose: () => {} }),
    },
    keybinding: undefined,
    effect<T>(factory: () => T): T {
      return factory()
    },
  } as unknown as CanvasContext

  zoomPlugin.apply(context, undefined)

  return {
    state,
    fitCalls,
    /** 模拟一次视口变化通知（canvas-core 的 attach / ResizeObserver 都走这条路） */
    notify(): void {
      for (const listener of listeners) listener()
    },
  }
}

describe('打开文档时的首帧适配', () => {
  it('1440 宽的页面在 735px 舞台上溢出，于是收缩一次视口', () => {
    const harness = createHarness({
      size: { width: 735, height: 197 },
      bounds: rect(1440, 810),
    })

    harness.notify()

    expect(harness.fitCalls).toEqual([{ rect: rect(1440, 810), padding: FIT_PADDING }])
  })

  it('整页在 100% 下就装得下时不动视口，保住用户习惯的原始缩放', () => {
    const harness = createHarness({
      size: { width: 1289, height: 737 },
      bounds: rect(800, 500),
    })

    harness.notify()

    expect(harness.fitCalls).toEqual([])
  })

  it('舞台高度不够也算溢出：宽装得下、高装不下照样收缩', () => {
    const harness = createHarness({
      size: { width: 1289, height: 737 },
      bounds: rect(800, 700),
    })

    harness.notify()

    expect(harness.fitCalls.length).toBe(1)
  })

  it('只做一次：后续视口变化（折叠 dock、改窗口大小）不再覆盖用户缩放', () => {
    const harness = createHarness({
      size: { width: 735, height: 197 },
      bounds: rect(1440, 810),
    })

    harness.notify()
    harness.state.size = { width: 300, height: 100 }
    harness.notify()
    harness.notify()

    expect(harness.fitCalls.length).toBe(1)
  })

  it('尺寸尚未测得时不消耗这一次机会，测到之后仍能适配', () => {
    const harness = createHarness({
      size: { width: 0, height: 0 },
      bounds: rect(1440, 810),
    })

    harness.notify()
    expect(harness.fitCalls).toEqual([])

    harness.state.size = { width: 735, height: 197 }
    harness.notify()
    expect(harness.fitCalls.length).toBe(1)
  })

  it('根矩形还没登记（宽高为 0）时不消耗这一次机会，几何到位后仍能适配', () => {
    const harness = createHarness({
      size: { width: 735, height: 197 },
      bounds: rect(0, 0),
    })

    harness.notify()
    expect(harness.fitCalls).toEqual([])

    harness.state.bounds = rect(1440, 810)
    harness.notify()
    expect(harness.fitCalls.length).toBe(1)
  })

  it('根节点缺失时 core 回落的 100×40 兜底矩形会被当成装得下，不放大成糊图', () => {
    const harness = createHarness({
      size: { width: 735, height: 197 },
      bounds: rect(100, 40),
    })

    harness.notify()

    expect(harness.fitCalls).toEqual([])
  })
})
