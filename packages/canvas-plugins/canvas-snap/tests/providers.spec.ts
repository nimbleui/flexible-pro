import type { SnapContext } from '@lc/contracts'
import type { NodeSchema, Rect } from '@lc/schema'
import { describe, expect, it } from 'vitest'
import { elementCandidates, gridCandidates } from '../src/providers'

/** 被拖元素：左边 120 正好落在 8px 网格上，右边 340 不在 */
const movingRect: Rect = { x: 120, y: 220, width: 220, height: 150 }

function context(overrides: Partial<SnapContext> = {}): SnapContext {
  return {
    zoom: 1,
    viewportRect: { x: 0, y: 0, width: 1000, height: 800 },
    moving: [movingRect],
    thresholdWorld: 6,
    movingIds: ['cardA'],
    ...overrides,
  }
}

function node(id: string, rect: Rect): NodeSchema {
  return { id, componentName: 'Box', layout: { mode: 'absolute', rect } }
}

describe('网格吸附候选', () => {
  it('边已经落在网格线上时不产生候选，避免吸附到自己当前位置', () => {
    const candidates = gridCandidates(context(), 8)

    expect(candidates.some((c) => c.axis === 'x' && c.value === 120)).toBe(false)
    expect(candidates.filter((c) => c.axis === 'x').map((c) => c.value)).toEqual([336, 344])
  })

  it('候选不画辅助线，网格本身已由 canvas-grid 呈现', () => {
    const candidates = gridCandidates(context(), 8)

    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      expect(candidate.source).toBe('grid')
      expect(candidate.showGuide).toBe(false)
    }
  })

  it('只保留世界阈值内的网格线', () => {
    const candidates = gridCandidates(context({ thresholdWorld: 2 }), 8)

    // 底边 370 距 368 为 2，是唯一落在阈值内的网格线
    expect(candidates).toEqual([{ axis: 'y', value: 368, source: 'grid', showGuide: false }])
  })
})

describe('元素吸附候选', () => {
  const nodes = {
    cardA: node('cardA', movingRect),
    cardB: node('cardB', { x: 372, y: 220, width: 220, height: 150 }),
  }

  it('排除 movingIds 中的自身节点', () => {
    const candidates = elementCandidates(context(), nodes)

    expect(new Set(candidates.map((c) => c.source))).toEqual(new Set(['node:cardB']))
  })

  it('缺少 movingIds 时不做排除，由调用方负责传入被拖节点', () => {
    const candidates = elementCandidates(context({ movingIds: undefined }), nodes)

    expect(candidates.map((c) => c.source)).toContain('node:cardA')
  })

  it('元素候选位于网格层之上', () => {
    const candidates = elementCandidates(context(), nodes)

    expect(new Set(candidates.map((c) => c.priority))).toEqual(new Set([1]))
  })
})
