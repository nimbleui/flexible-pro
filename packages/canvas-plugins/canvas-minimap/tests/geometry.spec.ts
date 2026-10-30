import type { Rect, Size } from '@lc/schema'
import { describe, expect, it } from 'vitest'
import {
  MINIMAP_HEADER,
  MINIMAP_MARGIN,
  MINIMAP_SIZE,
  fitLayout,
  layoutFor,
  mapOrigin,
  toMapRect,
  toWorldPoint,
  unionOf,
  viewportWorldRect,
} from '../src/geometry'

const box: Size = { width: 200, height: 100 }

describe('小地图映射', () => {
  it('等比缩放并居中，宽度是限制边时高度留白', () => {
    const layout = fitLayout({ x: 0, y: 0, width: 400, height: 100 }, box)

    // min(200×0.92/400, 100×0.92/100) → 宽边先撞限，scale 取小的一侧
    expect(layout.scale).toBeCloseTo(0.46, 6)
    const mapped = toMapRect(layout, { x: 0, y: 0, width: 400, height: 100 })
    expect(mapped.width).toBeCloseTo(184, 6)
    expect(mapped.height).toBeCloseTo(46, 6)
    expect(mapped.left).toBeCloseTo(8, 6)
    expect(mapped.top).toBeCloseTo(27, 6)
  })

  it('退化包围盒不会算出 Infinity 或 NaN', () => {
    const layout = fitLayout({ x: 50, y: 50, width: 0, height: 0 }, box)
    expect(layout.scale).toBeCloseTo(92, 6)
  })

  it('世界点与小地图坐标互逆', () => {
    const layout = fitLayout({ x: 120, y: 60, width: 820, height: 540 }, MINIMAP_SIZE)
    const world = { x: 400, y: 300 }
    const mapped = toMapRect(layout, { ...world, width: 0, height: 0 })
    const back = toWorldPoint(layout, mapped.left, mapped.top)

    expect(back.x).toBeCloseTo(world.x, 6)
    expect(back.y).toBeCloseTo(world.y, 6)
  })

  it('可见世界矩形按 zoom 换算', () => {
    expect(viewportWorldRect({ x: 100, y: 50, zoom: 2 }, { width: 800, height: 400 })).toEqual({
      x: 100,
      y: 50,
      width: 400,
      height: 200,
    })
  })

  it('并集在任一侧缺失时返回另一侧', () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 }
    const b: Rect = { x: 5, y: -4, width: 20, height: 8 }

    expect(unionOf(a, b)).toEqual({ x: 0, y: -4, width: 25, height: 14 })
    expect(unionOf(undefined, b)).toBe(b)
    expect(unionOf(a, undefined)).toBe(a)
  })

  it('映射范围包含文档与可见区，视口框完整落在地图内', () => {
    const root: Rect = { x: 0, y: 0, width: 500, height: 400 }
    const viewport = { x: 400, y: 300, zoom: 1 }
    const stage: Size = { width: 900, height: 700 }

    const layout = layoutFor(root, viewport, stage)
    const mapped = toMapRect(layout, viewportWorldRect(viewport, stage))

    expect(mapped.left).toBeGreaterThanOrEqual(0)
    expect(mapped.top).toBeGreaterThanOrEqual(0)
    expect(mapped.left + mapped.width).toBeLessThanOrEqual(MINIMAP_SIZE.width + 0.5)
    expect(mapped.top + mapped.height).toBeLessThanOrEqual(MINIMAP_SIZE.height + 0.5)
  })

  it('小地图贴在舞台右下角，并给标题条留出高度', () => {
    const origin = mapOrigin({ width: 1000, height: 600 })

    expect(origin.x).toBe(1000 - MINIMAP_SIZE.width - MINIMAP_MARGIN)
    expect(origin.y).toBe(600 - MINIMAP_SIZE.height - MINIMAP_MARGIN - MINIMAP_HEADER)
  })
})
