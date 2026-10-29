import { describe, expect, it } from 'vitest'
import { createHitTest } from '../src/hitTest'
import { createScene } from '../src/scene'
import { createViewport } from '../src/viewport'

function setup(): {
  scene: ReturnType<typeof createScene>
  viewport: ReturnType<typeof createViewport>
  hitTest: ReturnType<typeof createHitTest>
} {
  const scene = createScene({
    getRootRect: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  })
  const viewport = createViewport({ size: { width: 1000, height: 800 } })
  const hitTest = createHitTest({
    scene,
    viewport,
    isContainer: (nodeId) => nodeId === 'a',
  })
  return { scene, viewport, hitTest }
}

describe('命中测试', () => {
  it('命中最后登记（最上层）的节点', () => {
    const { scene, hitTest } = setup()
    scene.register('a', { x: 100, y: 100, width: 200, height: 200 })
    scene.register('b', { x: 150, y: 150, width: 100, height: 100 })

    expect(hitTest.at({ x: 180, y: 180 })).toBe('b')
    expect(hitTest.at({ x: 110, y: 110 })).toBe('a')
    expect(hitTest.at({ x: 10, y: 10 })).toBeUndefined()
  })

  it('随视口缩放换算世界坐标', () => {
    const { scene, viewport, hitTest } = setup()
    scene.register('a', { x: 100, y: 100, width: 200, height: 200 })

    viewport.set({ zoom: 2, x: 0, y: 0 })

    // 世界 (120,120) 在 zoom=2 下位于屏幕 (240,240)
    expect(hitTest.at({ x: 240, y: 240 })).toBe('a')
    expect(hitTest.at({ x: 120, y: 120 })).toBeUndefined()
  })

  it('框选按世界 AABB 返回相交节点', () => {
    const { scene, hitTest } = setup()
    scene.register('a', { x: 100, y: 100, width: 100, height: 100 })
    scene.register('b', { x: 400, y: 400, width: 100, height: 100 })

    const ids = hitTest.inRect({ x: 0, y: 0, width: 250, height: 250 })
    expect(ids).toEqual(['a'])
  })

  it('容器命中跳过普通节点', () => {
    const { scene, hitTest } = setup()
    scene.register('a', { x: 0, y: 0, width: 500, height: 500 })
    scene.register('b', { x: 100, y: 100, width: 100, height: 100 })

    expect(hitTest.at({ x: 150, y: 150 })).toBe('b')
    expect(hitTest.containerAt({ x: 150, y: 150 })).toBe('a')
  })

  it('不可选节点被穿过，但仍可作为容器接收投递', () => {
    const scene = createScene({
      getRootRect: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    })
    const viewport = createViewport({ size: { width: 1000, height: 800 } })
    const hitTest = createHitTest({
      scene,
      viewport,
      isContainer: (nodeId) => nodeId === 'a' || nodeId === 'lockedBox',
      isSelectable: (nodeId) => nodeId !== 'lockedBox',
    })
    scene.register('a', { x: 0, y: 0, width: 500, height: 500 })
    scene.register('lockedBox', { x: 100, y: 100, width: 100, height: 100 })

    // 指针落在锁定框里：命中的是它下面的容器，而不是锁定框自己
    expect(hitTest.at({ x: 150, y: 150 })).toBe('a')
    // 框选同样收不到它
    expect(hitTest.inRect({ x: 0, y: 0, width: 300, height: 300 })).toEqual(['a'])
    // containerAt 不受可选性影响，否则锁定容器会变成投递黑洞
    expect(hitTest.containerAt({ x: 150, y: 150 })).toBe('lockedBox')
  })
})
