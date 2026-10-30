import { describe, expect, it } from 'vitest'
import {
  applyEdgeSnap,
  edgeModesOf,
  resizeRect,
  resizeRotatedRect,
  scaleSelection,
} from '../src/geometry'

const base = { x: 0, y: 0, width: 100, height: 50 }

describe('节点/选区缩放几何', () => {
  it('东侧手柄改变宽度，锚定左边', () => {
    const next = resizeRect(base, 'e', { x: 150, y: 0 })
    expect(next).toEqual({ x: 0, y: 0, width: 150, height: 50 })
  })

  it('西侧手柄锚定右边并受最小尺寸约束', () => {
    const next = resizeRect(base, 'w', { x: 200, y: 0 })
    expect(next).toEqual({ x: 92, y: 0, width: 8, height: 50 })
  })

  it('角手柄保持宽高比（se，以宽为主）', () => {
    const next = resizeRect(base, 'se', { x: 200, y: 80 }, { keepAspect: true })
    expect(next).toEqual({ x: 0, y: 0, width: 200, height: 100 })
  })

  it('角手柄保持宽高比（ne，锚定底边）', () => {
    const next = resizeRect(base, 'ne', { x: 200, y: -30 }, { keepAspect: true })
    expect(next).toEqual({ x: 0, y: -50, width: 200, height: 100 })
  })

  it('边缘手柄忽略等比约束', () => {
    const next = resizeRect(base, 'e', { x: 200, y: 0 }, { keepAspect: true })
    expect(next).toEqual({ x: 0, y: 0, width: 200, height: 50 })
  })

  it('多选按包围盒映射比例缩放各节点', () => {
    const nodes = [
      { id: 'a', rect: { x: 0, y: 0, width: 100, height: 100 } },
      { id: 'b', rect: { x: 200, y: 100, width: 100, height: 100 } },
    ]

    const scaled = scaleSelection(
      nodes,
      { x: 0, y: 0, width: 300, height: 200 },
      { x: 0, y: 0, width: 600, height: 200 },
    )

    expect(scaled).toEqual([
      { id: 'a', rect: { x: 0, y: 0, width: 200, height: 100 } },
      { id: 'b', rect: { x: 400, y: 100, width: 200, height: 100 } },
    ])
  })

  it('缩放到极小时节点仍保留 1px 尺寸', () => {
    const nodes = [{ id: 'a', rect: { x: 0, y: 0, width: 100, height: 100 } }]
    const scaled = scaleSelection(
      nodes,
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 0.5, height: 0.5 },
    )
    expect(scaled[0]?.rect.width).toBe(1)
    expect(scaled[0]?.rect.height).toBe(1)
  })
})

describe('旋转感知缩放', () => {
  const rotatedBase = { x: -50, y: -25, width: 100, height: 50 }

  it('旋转 0 时与普通缩放等价', () => {
    const next = resizeRotatedRect({
      rect: base,
      rotation: 0,
      handleId: 'se',
      point: { x: 150, y: 80 },
    })
    expect(next).toEqual(resizeRect(base, 'se', { x: 150, y: 80 }))
  })

  it('旋转 90° 时 se 手柄沿节点局部轴放大', () => {
    // 局部指针 (100, 50) 旋转 90° 后的世界坐标是 (-50, 100)
    const next = resizeRotatedRect({
      rect: rotatedBase,
      rotation: Math.PI / 2,
      handleId: 'se',
      point: { x: -50, y: 100 },
    })

    expect(next.width).toBeCloseTo(150, 8)
    expect(next.height).toBeCloseTo(75, 8)
    expect(next.x).toBeCloseTo(-87.5, 8)
    expect(next.y).toBeCloseTo(-12.5, 8)
  })

  it('旋转后拖拽手柄，对侧锚点在世界空间保持不动', () => {
    const rotation = Math.PI / 4
    const start = { x: 20, y: 30, width: 200, height: 100 }
    const next = resizeRotatedRect({
      rect: start,
      rotation,
      handleId: 'se',
      point: { x: 400, y: 260 },
    })

    const startCenter = { x: start.x + start.width / 2, y: start.y + start.height / 2 }
    const nextCenter = { x: next.x + next.width / 2, y: next.y + next.height / 2 }
    const rotate = (
      point: { x: number; y: number },
      center: { x: number; y: number },
    ): { x: number; y: number } => {
      const cos = Math.cos(rotation)
      const sin = Math.sin(rotation)
      return {
        x: center.x + (point.x - center.x) * cos - (point.y - center.y) * sin,
        y: center.y + (point.x - center.x) * sin + (point.y - center.y) * cos,
      }
    }

    const anchorBefore = rotate({ x: start.x, y: start.y }, startCenter)
    const anchorAfter = rotate({ x: next.x, y: next.y }, nextCenter)
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 6)
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 6)
  })

  it('手柄吸附只改动正在拖的边', () => {
    // 东侧手柄：右边 +6，左边不动
    expect(applyEdgeSnap(base, 'e', { x: 6, y: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 106,
      height: 50,
    })
    // 西侧手柄：左边左移 6，宽度增加、右锚点不变
    expect(applyEdgeSnap(base, 'w', { x: -6, y: 0 })).toEqual({
      x: -6,
      y: 0,
      width: 106,
      height: 50,
    })
    // 西北角：两条边同时生效
    expect(applyEdgeSnap(base, 'nw', { x: -6, y: -4 })).toEqual({
      x: -6,
      y: -4,
      width: 106,
      height: 54,
    })
  })

  it('吸附位移会把边长压到下限时整帧放弃吸附', () => {
    const wide = { x: 0, y: 0, width: 10, height: 50 }
    expect(applyEdgeSnap(wide, 'e', { x: -20, y: 0 }, 8)).toEqual(wide)
    expect(applyEdgeSnap(wide, 'e', { x: -1, y: 0 }, 8)).toEqual({
      x: 0,
      y: 0,
      width: 9,
      height: 50,
    })
  })

  it('手柄 id 映射到参与吸附的边', () => {
    expect(edgeModesOf('e')).toEqual({ x: 'end' })
    expect(edgeModesOf('w')).toEqual({ x: 'start' })
    expect(edgeModesOf('n')).toEqual({ y: 'start' })
    expect(edgeModesOf('se')).toEqual({ x: 'end', y: 'end' })
    expect(edgeModesOf('nw')).toEqual({ x: 'start', y: 'start' })
  })
})
