import { describe, expect, it, vi } from 'vitest'

describe('createUniquePersistentId', () => {
  it('taken 为空时返回带前缀的可落盘 id', async () => {
    const { createUniquePersistentId } = await import('../src/id')

    const id = createUniquePersistentId('conn', [])

    expect(id.startsWith('conn-')).toBe(true)
    expect(id.length).toBeGreaterThan('conn-'.length)
  })

  it('与既有键冲突时换一个 id，结果不与 taken 重复且仍带前缀', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    vi.spyOn(Math, 'random').mockReturnValue(0)

    try {
      // 固定时间与随机后，全新模块实例的第一个 id 只由模块内序号决定。
      // 用一份实例造出「文档里已占用的键」，另一份全新实例的首个候选必然与之相同，
      // 从而稳定走到查重重试分支，而不是依赖 createPersistentId 偶然撞上。
      vi.resetModules()
      const seeding = await import('../src/id')
      const taken = [seeding.createPersistentId('conn')]

      vi.resetModules()
      const { createUniquePersistentId } = await import('../src/id')
      const id = createUniquePersistentId('conn', taken)

      expect(taken).not.toContain(id)
      expect(id.startsWith('conn-')).toBe(true)
      expect(new Set([...taken, id]).size).toBe(2)
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

  it('taken 含多个已占用键时，连续生成的 id 彼此不同且都不在 taken 内', async () => {
    const { createUniquePersistentId } = await import('../src/id')
    const taken = ['conn-imported-1', 'conn-imported-2', 'conn-imported-3']

    const first = createUniquePersistentId('conn', taken)
    const second = createUniquePersistentId('action', [...taken, first])

    expect(taken).not.toContain(first)
    expect(taken).not.toContain(second)
    expect(first.startsWith('conn-')).toBe(true)
    expect(second.startsWith('action-')).toBe(true)
    expect(first).not.toBe(second)
  })
})
