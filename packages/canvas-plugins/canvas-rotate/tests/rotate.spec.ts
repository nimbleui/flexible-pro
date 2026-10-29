import { describe, expect, it } from 'vitest'
import { normalizeDegrees, placeRotateHandle, rotateNodes, snapRadians } from '../src/rotate'

describe('旋转几何', () => {
  it('绕组中心旋转 90° 同时累加自身角度', () => {
    const rotated = rotateNodes(
      [{ id: 'a', rect: { x: 9, y: -1, width: 2, height: 2 }, rotate: 0 }],
      { x: 0, y: 0 },
      Math.PI / 2,
    )

    const node = rotated[0]!
    expect(node.rect.x).toBeCloseTo(-1, 8)
    expect(node.rect.y).toBeCloseTo(9, 8)
    expect(node.rotate).toBeCloseTo(90, 8)
  })

  it('多次旋转后角度归一化到 (-180, 180]', () => {
    const rotated = rotateNodes(
      [{ id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 }, rotate: 350 }],
      { x: 5, y: 5 },
      (20 * Math.PI) / 180,
    )
    expect(rotated[0]?.rotate).toBeCloseTo(10, 8)
  })

  it('normalizeDegrees 边界', () => {
    expect(normalizeDegrees(180)).toBe(180)
    expect(normalizeDegrees(-180)).toBe(180)
    expect(normalizeDegrees(540)).toBe(180)
    expect(normalizeDegrees(361)).toBeCloseTo(1, 8)
    expect(normalizeDegrees(-361)).toBeCloseTo(-1, 8)
  })

  it('Shift 吸附到 15° 步进', () => {
    const twentyDegrees = (20 * Math.PI) / 180
    const snapped = (snapRadians(twentyDegrees) * 180) / Math.PI
    expect(snapped).toBeCloseTo(15, 8)

    const thirtyEight = (38 * Math.PI) / 180
    expect((snapRadians(thirtyEight) * 180) / Math.PI).toBeCloseTo(45, 8)
  })
})

describe('旋转手柄定位', () => {
  it('未旋转时位于顶边上方', () => {
    const placement = placeRotateHandle({ x: 100, y: 100 }, 40, 28, 0)
    expect(placement.topMid).toEqual({ x: 100, y: 60 })
    expect(placement.handle).toEqual({ x: 100, y: 32 })
  })

  it('旋转 90° 后手柄绕中心转到右侧', () => {
    const placement = placeRotateHandle({ x: 0, y: 0 }, 40, 10, Math.PI / 2)
    expect(placement.topMid.x).toBeCloseTo(40, 8)
    expect(placement.topMid.y).toBeCloseTo(0, 8)
    expect(placement.handle.x).toBeCloseTo(50, 8)
    expect(placement.handle.y).toBeCloseTo(0, 8)
  })

  it('旋转 180° 后手柄位于底边下方', () => {
    const placement = placeRotateHandle({ x: 0, y: 0 }, 40, 10, Math.PI)
    expect(placement.topMid.y).toBeCloseTo(40, 8)
    expect(placement.handle.y).toBeCloseTo(50, 8)
  })
})
