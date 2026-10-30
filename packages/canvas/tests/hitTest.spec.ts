import { describe, expect, it } from 'vitest'
import { createHitTest } from '../src/hitTest'
import { createScene } from '../src/scene'
import { createViewport } from '../src/viewport'

function setup(rotations: Record<string, number> = {}): {
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
    getRotation: (nodeId) => rotations[nodeId] ?? 0,
  })
  return { scene, viewport, hitTest }
}

/** 45° 弧度值：命中与框选都用它，避免测试里混用度数 */
const DIAGONAL = Math.PI / 4

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
      getRotation: () => 0,
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

/** 细长横条：旋转 45° 后外包络与真实形状差异最大，用它验证命中不再按 AABB */
const BAR = { x: 0, y: 0, width: 200, height: 20 }

describe('旋转节点命中', () => {
  it('外包络里的空白不再命中，转出 AABB 的本体仍然命中', () => {
    const { scene, hitTest } = setup({ a: DIAGONAL })
    scene.register('a', BAR)

    // 未旋转时 (10,5) 落在条带里；旋转 45° 后它只在外包络内、不在条带上
    expect(hitTest.at({ x: 10, y: 5 })).toBeUndefined()

    // 沿条带长轴离开中心 60 世界像素，正是 DOM 里能看到的部分
    const along = 60 * Math.SQRT1_2
    expect(hitTest.at({ x: 100 + along, y: 10 + along })).toBe('a')
  })

  it('框选收进旋转后越出 AABB 的节点', () => {
    const marquee = { x: 120, y: 60, width: 60, height: 60 }

    const rotated = setup({ a: DIAGONAL })
    rotated.scene.register('a', BAR)

    const upright = setup()
    upright.scene.register('a', BAR)

    expect(rotated.hitTest.inRect(marquee)).toEqual(['a'])
    // 不旋转时条带只在 y 0~20，框在 y 60~120，确实选不中
    expect(upright.hitTest.inRect(marquee)).toEqual([])
  })

  it('角度不是有限数时退化为未旋转命中，而不是让节点彻底点不中', () => {
    const { scene, hitTest } = setup({ a: Number.NaN })
    scene.register('a', BAR)

    expect(hitTest.at({ x: 10, y: 5 })).toBe('a')
  })
})
