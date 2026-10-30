import type { SnapContext } from '@lc/contracts'
import type { Rect } from '@lc/schema'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_GUIDES,
  addGuide,
  guideCandidates,
  guideHandleId,
  moveGuide,
  parseGuideHandleId,
  removeGuide,
  rulerStep,
  rulerTicks,
} from '../src/guides'
import type { UserGuides } from '../src/guides'

function context(
  values: { zoom?: number; viewportRect?: Rect; thresholdWorld?: number } = {},
): SnapContext {
  return {
    zoom: values.zoom ?? 1,
    viewportRect: values.viewportRect ?? { x: 0, y: 0, width: 1000, height: 800 },
    // 参考线候选不看被拖矩形，这里给一个即可
    moving: [{ x: 10, y: 10, width: 40, height: 20 }],
    thresholdWorld: values.thresholdWorld ?? 8,
  }
}

describe('参考线集合', () => {
  it('addGuide 只在自己那组里追加，且不重复添加同值', () => {
    const once = addGuide(EMPTY_GUIDES, 'horizontal', 120)
    const twice = addGuide(once, 'vertical', 80)

    expect(once.horizontal).toEqual([120])
    expect(once.vertical).toEqual([])
    expect(twice).toEqual({ horizontal: [120], vertical: [80] })
    expect(addGuide(twice, 'horizontal', 120)).toBe(twice)
  })

  it('moveGuide 与 removeGuide 对越界下标返回原集合', () => {
    const guides: UserGuides = { horizontal: [10, 20], vertical: [5] }

    expect(moveGuide(guides, 'horizontal', 1, 22).horizontal).toEqual([10, 22])
    expect(moveGuide(guides, 'horizontal', 5, 22)).toBe(guides)
    expect(removeGuide(guides, 'vertical', 0).vertical).toEqual([])
    expect(removeGuide(guides, 'vertical', -1)).toBe(guides)
  })

  it('不修改传入集合', () => {
    const guides: UserGuides = { horizontal: [10], vertical: [] }
    addGuide(guides, 'horizontal', 30)
    expect(guides.horizontal).toEqual([10])
  })
})

describe('参考线手柄 id', () => {
  it('生成与解析互逆', () => {
    expect(parseGuideHandleId(guideHandleId('horizontal', 0))).toEqual({
      axis: 'horizontal',
      index: 0,
    })
    expect(parseGuideHandleId(guideHandleId('vertical', 12))).toEqual({
      axis: 'vertical',
      index: 12,
    })
  })

  it('非参考线手柄返回 undefined', () => {
    expect(parseGuideHandleId('ruler-h')).toBeUndefined()
    expect(parseGuideHandleId('guide-h-x')).toBeUndefined()
    expect(parseGuideHandleId('rotate')).toBeUndefined()
  })
})

describe('参考线吸附候选', () => {
  it('水平线给出 y 轴候选、垂直线给出 x 轴候选', () => {
    const guides: UserGuides = { horizontal: [300], vertical: [500] }
    const candidates = guideCandidates(guides, context())

    expect(candidates).toEqual([
      { axis: 'y', value: 300, source: 'guide', priority: 2, showGuide: false },
      { axis: 'x', value: 500, source: 'guide', priority: 2, showGuide: false },
    ])
  })

  it('视口外的线不参与吸附', () => {
    const guides: UserGuides = { horizontal: [5000], vertical: [] }
    expect(guideCandidates(guides, context())).toEqual([])
  })

  it('贴着视口边缘外一个阈值内的线仍然可用，避免边界处吸不上', () => {
    const guides: UserGuides = { horizontal: [-6], vertical: [] }
    const candidates = guideCandidates(guides, context({ thresholdWorld: 8 }))
    expect(candidates.map((item) => item.value)).toEqual([-6])
  })
})

describe('标尺刻度步进', () => {
  it('缩放越大步进越小，屏幕间距始终不小于阈值', () => {
    expect(rulerStep(1)).toBe(100)
    expect(rulerStep(2)).toBe(50)
    expect(rulerStep(10)).toBe(10)
    expect(rulerStep(0.25)).toBe(500)
  })

  it('步进 × 缩放不会低于最小屏幕间距', () => {
    for (const zoom of [0.1, 0.33, 1, 1.7, 4]) {
      expect(rulerStep(zoom) * zoom).toBeGreaterThanOrEqual(64 * 0.999)
    }
  })

  it('异常缩放退回 1，不产生 NaN 步进', () => {
    expect(rulerStep(0)).toBe(1)
  })
})

describe('标尺刻度位置', () => {
  it('刻度按标尺条局部坐标给出，与拐角让掉的厚度对齐', () => {
    const ticks = rulerTicks({ originWorld: 100, zoom: 2, inset: 20, stageLength: 400 })

    // 世界 150 在 zoom=2 下位于舞台 x=100，条内要再减掉 20 的拐角厚度；
    // 按舞台坐标直接落位会整体偏出 20px，刻度与内容对不上
    expect(ticks.find((tick) => tick.label === '150')?.at).toBe(80)
    // 条内 0 处对应世界 110（原点 100 + 20/2），它是次刻度所以没有文字
    expect(ticks[0]).toEqual({ at: 0, major: false, label: undefined })
  })

  it('刻度覆盖到条的末端，不超出可用长度', () => {
    const ticks = rulerTicks({ originWorld: 100, zoom: 2, inset: 20, stageLength: 400 })

    // 可用长度 380，末端世界 300 正好贴边；再往外的刻度已经被拐角让掉，不该生成
    expect(ticks.at(-1)).toEqual({ at: 380, major: true, label: '300' })
    expect(ticks.every((tick) => tick.at >= -1 && tick.at <= 381)).toBe(true)
  })

  it('拐角吃满整条或缩放坏掉时不生成刻度', () => {
    expect(rulerTicks({ originWorld: 0, zoom: 1, inset: 20, stageLength: 20 })).toEqual([])
    expect(
      rulerTicks({ originWorld: 0, zoom: Number.NaN, inset: 20, stageLength: 400 }),
    ).toEqual([])
    expect(rulerTicks({ originWorld: 0, zoom: 0, inset: 20, stageLength: 400 })).toEqual([])
  })
})
