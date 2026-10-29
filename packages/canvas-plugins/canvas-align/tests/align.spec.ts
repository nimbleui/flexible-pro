import { describe, expect, it } from 'vitest'
import { alignRects, boundsOf, distributeRects } from '../src/align'

const nodes = [
  { id: 'a', rect: { x: 0, y: 0, width: 100, height: 60 } },
  { id: 'b', rect: { x: 200, y: 100, width: 60, height: 40 } },
]

describe('对齐', () => {
  it('包围盒计算', () => {
    expect(boundsOf(nodes)).toEqual({ x: 0, y: 0, width: 260, height: 140 })
  })

  it('六向对齐保持尺寸只改位置', () => {
    const widthOf = (mode: Parameters<typeof alignRects>[1]) =>
      alignRects(nodes, mode).map((node) => node.rect)

    expect(widthOf('left')[1]).toEqual({ x: 0, y: 100, width: 60, height: 40 })
    expect(widthOf('right')[1]).toEqual({ x: 200, y: 100, width: 60, height: 40 })
    expect(widthOf('top')[1]).toEqual({ x: 200, y: 0, width: 60, height: 40 })
    expect(widthOf('bottom')[1]).toEqual({ x: 200, y: 100, width: 60, height: 40 })
    expect(widthOf('centerX')[0]).toEqual({ x: 80, y: 0, width: 100, height: 60 })
    expect(widthOf('centerY')[1]).toEqual({ x: 200, y: 50, width: 60, height: 40 })
  })
})

describe('等间距分布', () => {
  it('水平分布首尾固定、边到边间距一致', () => {
    const items = [
      { id: 'a', rect: { x: 0, y: 0, width: 100, height: 50 } },
      { id: 'b', rect: { x: 300, y: 0, width: 100, height: 50 } },
      { id: 'c', rect: { x: 500, y: 0, width: 100, height: 50 } },
    ]

    const distributed = distributeRects(items, 'x')
    expect(distributed.map((node) => node.rect.x)).toEqual([0, 250, 500])
    expect(distributed[0]?.rect.x).toBe(0)
    expect(distributed[2]?.rect.x).toBe(500)
  })

  it('垂直分布按 y 轴等间距', () => {
    const items = [
      { id: 'a', rect: { x: 0, y: 0, width: 50, height: 100 } },
      { id: 'b', rect: { x: 0, y: 200, width: 50, height: 100 } },
      { id: 'c', rect: { x: 0, y: 500, width: 50, height: 100 } },
    ]

    const distributed = distributeRects(items, 'y')
    expect(distributed.map((node) => node.rect.y)).toEqual([0, 250, 500])
  })

  it('少于 3 个节点返回原位置副本', () => {
    const items = nodes.slice(0, 2)
    const distributed = distributeRects(items, 'x')
    expect(distributed.map((node) => node.rect)).toEqual(items.map((node) => node.rect))
    expect(distributed).not.toBe(items)
  })
})
