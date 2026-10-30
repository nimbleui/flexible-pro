import { describe, expect, it } from 'vitest'
import { createViewport } from '../src/viewport'

describe('viewport 坐标变换', () => {
  it('screenToWorld / worldToScreen 往返一致（含旋转）', () => {
    const viewport = createViewport({
      initial: { x: 40, y: -20, zoom: 1.75, rotation: Math.PI / 5 },
      size: { width: 1200, height: 800 },
    })

    for (const point of [
      { x: 0, y: 0 },
      { x: 320, y: 180 },
      { x: -90, y: 45 },
    ]) {
      const roundtrip = viewport.screenToWorld(viewport.worldToScreen(point))
      expect(roundtrip.x).toBeCloseTo(point.x, 8)
      expect(roundtrip.y).toBeCloseTo(point.y, 8)
    }
  })

  it('zoomAt 保持指针下的世界坐标不动', () => {
    for (const zoom of [0.1, 0.5, 1, 2, 4]) {
      for (const rotation of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        const viewport = createViewport({
          initial: { x: 12, y: 34, zoom, rotation },
          size: { width: 800, height: 600 },
        })
        const pointer = { x: 260, y: 180 }
        const before = viewport.screenToWorld(pointer)

        viewport.zoomAt(pointer, 1.6)

        const after = viewport.screenToWorld(pointer)
        expect(after.x).toBeCloseTo(before.x, 6)
        expect(after.y).toBeCloseTo(before.y, 6)
      }
    }
  })

  it('zoom 被 clamp 到配置范围', () => {
    const viewport = createViewport({
      minZoom: 0.5,
      maxZoom: 2,
      size: { width: 400, height: 300 },
    })
    viewport.zoomAt({ x: 0, y: 0 }, 100)
    expect(viewport.state.zoom).toBe(2)
    viewport.zoomAt({ x: 0, y: 0 }, 0.0001)
    expect(viewport.state.zoom).toBe(0.5)
  })

  it('panBy 按屏幕像素平移内容', () => {
    const viewport = createViewport({
      initial: { x: 0, y: 0, zoom: 2, rotation: 0 },
      size: { width: 400, height: 300 },
    })
    const worldBefore = viewport.screenToWorld({ x: 100, y: 100 })

    viewport.panBy({ x: 30, y: -10 })

    // 内容向右下移动后，同一世界点应出现在新的屏幕位置
    const screenAfter = viewport.worldToScreen(worldBefore)
    expect(screenAfter.x).toBeCloseTo(130, 6)
    expect(screenAfter.y).toBeCloseTo(90, 6)
  })

  it('fit 让目标矩形完整落在视口内', () => {
    const viewport = createViewport({ size: { width: 1000, height: 800 } })
    viewport.fit({ x: 100, y: 100, width: 400, height: 200 }, 40)

    const topLeft = viewport.worldToScreen({ x: 100, y: 100 })
    const bottomRight = viewport.worldToScreen({ x: 500, y: 300 })

    expect(topLeft.x).toBeGreaterThanOrEqual(0)
    expect(topLeft.y).toBeGreaterThanOrEqual(0)
    expect(bottomRight.x).toBeLessThanOrEqual(1000)
    expect(bottomRight.y).toBeLessThanOrEqual(800)
  })
})

describe('视口数值防护', () => {
  it('非有限的 zoom 不写入，矩阵保持可用', () => {
    const viewport = createViewport({ size: { width: 400, height: 300 } })

    viewport.set({ zoom: Number.NaN })

    expect(viewport.state.zoom).toBe(1)
    expect(viewport.matrix.every(Number.isFinite)).toBe(true)
  })

  it('NaN 平移量被忽略，世界坐标换算不漂移', () => {
    const viewport = createViewport({
      initial: { x: 10, y: 20, zoom: 2 },
      size: { width: 400, height: 300 },
    })
    const before = viewport.screenToWorld({ x: 100, y: 100 })

    viewport.panBy({ x: Number.NaN, y: Number.POSITIVE_INFINITY })

    expect(viewport.screenToWorld({ x: 100, y: 100 })).toEqual(before)
  })

  it('fit 拒掉非有限的矩形尺寸，缩放保持原样', () => {
    const viewport = createViewport({ size: { width: 400, height: 300 } })
    viewport.set({ zoom: 2 })

    viewport.fit({ x: 0, y: 0, width: Number.NaN, height: 100 })

    expect(viewport.state.zoom).toBe(2)
  })

  it('尺寸坏值分别收敛为当前值与 0', () => {
    const viewport = createViewport({ size: { width: 400, height: 300 } })

    viewport.setSize({ width: Number.NaN, height: -5 })

    expect(viewport.size).toEqual({ width: 400, height: 0 })
  })

  it('持久化恢复里的坏字段回落到缺省值', () => {
    const viewport = createViewport({
      initial: { x: Number.NaN, y: 5, zoom: Number.NaN, rotation: Number.NaN },
    })

    expect(viewport.state).toEqual({ x: 0, y: 5, zoom: 1, rotation: 0 })
  })

  it('被拒绝的坏值不触发多余通知', () => {
    const viewport = createViewport({ size: { width: 400, height: 300 } })
    let calls = 0
    viewport.onDidChange(() => {
      calls += 1
    })

    viewport.set({ zoom: Number.NaN })

    expect(calls).toBe(0)
  })
})
