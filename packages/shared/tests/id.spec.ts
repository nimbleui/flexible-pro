import { describe, expect, it, vi } from 'vitest'
import { createId, createPersistentId } from '../src/id'

describe('createPersistentId', () => {
  it('同一 tick 批量创建 1000 个无重复', () => {
    const ids = Array.from({ length: 1000 }, () => createPersistentId('page'))

    expect(new Set(ids).size).toBe(1000)
    expect(ids.every((id) => id.startsWith('page-'))).toBe(true)
  })

  it('不同前缀共享同一套唯一性保证', () => {
    const ids = Array.from({ length: 200 }, (_, index) =>
      index % 2 === 0 ? createPersistentId('node') : createPersistentId('api'),
    )

    expect(new Set(ids).size).toBe(200)
  })

  it('时间与随机都被固定时仍能前进，不会死循环或产出重复 id', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    vi.spyOn(Math, 'random').mockReturnValue(0)

    try {
      const ids = Array.from({ length: 50 }, () => createPersistentId('page'))

      expect(new Set(ids).size).toBe(50)
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

  it('与运行时 createId 不共享序号，且形态不同', () => {
    const runtime = createId('node')
    const persistent = createPersistentId('node')

    expect(runtime.startsWith('node-')).toBe(true)
    expect(persistent.startsWith('node-')).toBe(true)
    expect(persistent).not.toBe(runtime)
  })
})
