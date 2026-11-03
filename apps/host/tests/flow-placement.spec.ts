import { describe, expect, it } from 'vitest'
import type { Point, Rect } from '@lc/contracts'
import { firstFreePosition } from '../src/components/flow/utils/node-placement'

const SIZE = { width: 208, height: 66 }

function overlaps(a: Point, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + SIZE.width > b.x &&
    a.y < b.y + b.height &&
    a.y + SIZE.height > b.y
  )
}

describe('新建节点落点避让', () => {
  it('期望位置空着时原样返回，不做无谓偏移', () => {
    const occupied: Rect[] = [{ x: 900, y: 900, width: 208, height: 66 }]

    expect(firstFreePosition({ x: 100, y: 100 }, SIZE, occupied)).toEqual({ x: 100, y: 100 })
  })

  it('没有既有节点时同样原样返回', () => {
    expect(firstFreePosition({ x: 320, y: 80 }, SIZE, [])).toEqual({ x: 320, y: 80 })
  })

  it('与已有节点重叠时让位到不与任何矩形相交的位置', () => {
    const occupied: Rect[] = [{ x: 100, y: 100, ...SIZE }]

    const result = firstFreePosition({ x: 120, y: 110 }, SIZE, occupied)

    expect(result).not.toEqual({ x: 120, y: 110 })
    expect(overlaps(result, occupied[0])).toBe(false)
  })

  it('连续点击同一处添加时，每个新节点都不会压住前面的卡片', () => {
    // 复现「连线不了」的那条路径：落点恒为视口中心，卡片叠在一起后端口命中到别人的端口，
    // 拉线起止点被解析成同一个节点，连线当成自环被拒绝
    const occupied: Rect[] = []

    for (let index = 0; index < 5; index++) {
      const position = firstFreePosition({ x: 400, y: 300 }, SIZE, occupied)
      expect(occupied.some((rect) => overlaps(position, rect))).toBe(false)
      occupied.push({ ...position, ...SIZE })
    }

    expect(new Set(occupied.map((rect) => `${rect.x},${rect.y}`)).size).toBe(5)
  })

  it('对角全被占满时仍返回一个有限坐标，而不是卡在原位', () => {
    const occupied: Rect[] = Array.from({ length: 30 }, (_, index) => ({
      x: 400 + index * 36,
      y: 300 + index * 36,
      ...SIZE,
    }))

    const result = firstFreePosition({ x: 400, y: 300 }, SIZE, occupied)

    expect(Number.isFinite(result.x)).toBe(true)
    expect(Number.isFinite(result.y)).toBe(true)
    expect(result.x).toBeGreaterThan(400)
  })
})
