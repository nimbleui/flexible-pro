import { describe, expect, it } from 'vitest'
import { createSnapService } from '../src/snap/engine'

const viewportRect = { x: 0, y: 0, width: 1000, height: 800 }

describe('吸附引擎', () => {
  it('按屏幕像素阈值吸附，跨 zoom 手感一致', () => {
    const snap = createSnapService({ thresholdScreenPx: 6 })
    snap.registerProvider({
      id: 'edges',
      getCandidates: () => [{ axis: 'x', value: 100, source: 'edge' }],
    })

    const atZoom1 = snap.resolve({
      rects: [{ x: 96, y: 0, width: 40, height: 40 }],
      zoom: 1,
      viewportRect,
    })
    expect(atZoom1.delta.x).toBeCloseTo(4)
    expect(atZoom1.matched).toBe(true)

    // zoom 0.5：世界阈值放大到 12，同样 10 的差距仍可吸附
    const atZoomHalf = snap.resolve({
      rects: [{ x: 90, y: 0, width: 40, height: 40 }],
      zoom: 0.5,
      viewportRect,
    })
    expect(atZoomHalf.matched).toBe(true)

    // zoom 4：世界阈值 1.5，10 的差距不再吸附
    const atZoom4 = snap.resolve({
      rects: [{ x: 90, y: 0, width: 40, height: 40 }],
      zoom: 4,
      viewportRect,
    })
    expect(atZoom4.matched).toBe(false)
  })

  it('先按 priority 分层，层内取距离最近者', () => {
    const snap = createSnapService({ thresholdScreenPx: 10 })
    snap.registerProvider({
      id: 'multi',
      getCandidates: () => [
        { axis: 'y', value: 100, source: 'grid', priority: 0 },
        { axis: 'y', value: 103, source: 'node:b', priority: 1 },
        { axis: 'y', value: 104, source: 'node:a', priority: 1 },
      ],
    })

    const result = snap.resolve({
      rects: [{ x: 0, y: 100, width: 50, height: 50 }],
      zoom: 1,
      viewportRect,
    })

    // 距离 0 的网格候选输给元素层：网格候选由被拖元素自身几何推导，永远贴着它
    expect(result.delta.y).toBe(3)
    expect(result.guides[0]?.source).toBe('node:b')
  })

  it('同优先级同距离按 source 字典序稳定排序', () => {
    const snap = createSnapService({ thresholdScreenPx: 10 })
    snap.registerProvider({
      id: 'tie',
      getCandidates: () => [
        { axis: 'y', value: 100, source: 'node:b', priority: 1 },
        { axis: 'y', value: 100, source: 'node:a', priority: 1 },
      ],
    })

    const result = snap.resolve({
      rects: [{ x: 0, y: 100, width: 50, height: 50 }],
      zoom: 1,
      viewportRect,
    })

    expect(result.delta.y).toBe(0)
    expect(result.guides[0]?.source).toBe('node:a')
  })

  it('showGuide 为 false 的候选只吸附不画辅助线', () => {
    const snap = createSnapService({ thresholdScreenPx: 8 })
    snap.registerProvider({
      id: 'grid',
      getCandidates: () => [{ axis: 'x', value: 100, source: 'grid', showGuide: false }],
    })

    const result = snap.resolve({
      rects: [{ x: 86, y: 0, width: 10, height: 10 }],
      zoom: 1,
      viewportRect,
    })

    expect(result.delta.x).toBeCloseTo(4)
    expect(result.matched).toBe(true)
    expect(result.guides).toHaveLength(0)
  })

  it('生成辅助线并记录 lastResult', () => {
    const snap = createSnapService({ thresholdScreenPx: 8 })
    snap.registerProvider({
      id: 'center',
      getCandidates: () => [{ axis: 'x', value: 200, source: 'center' }],
    })

    const result = snap.resolve({
      rects: [{ x: 194, y: 20, width: 10, height: 10 }],
      zoom: 1,
      viewportRect,
    })

    expect(result.guides).toHaveLength(1)
    expect(result.guides[0]).toMatchObject({ axis: 'x', value: 200, source: 'center' })
    expect(snap.lastResult).toBe(result)
  })

  it('禁用后直接返回空结果', () => {
    const snap = createSnapService({ enabled: false })
    snap.registerProvider({
      id: 'edges',
      getCandidates: () => [{ axis: 'x', value: 0, source: 'edge' }],
    })

    const result = snap.resolve({
      rects: [{ x: 0, y: 0, width: 10, height: 10 }],
      zoom: 1,
      viewportRect,
    })

    expect(result.matched).toBe(false)
    expect(snap.lastResult).toBeNull()
  })
})
