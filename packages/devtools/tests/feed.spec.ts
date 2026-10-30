import { describe, expect, it } from 'vitest'
import type { EventDispatchRecord } from '@lc/kernel'
import { EventLog } from '../src/core/feed'

function record(overrides: Partial<EventDispatchRecord> = {}): EventDispatchRecord {
  return {
    name: 'document:change',
    mode: 'emit',
    duration: 1.2,
    listenerCount: 2,
    ...overrides,
  }
}

describe('EventLog', () => {
  it('倒序返回，序号单调递增且清空后不复用', () => {
    const log = new EventLog(10)

    log.push(record({ name: 'first' }), 1_000)
    log.push(record({ name: 'second' }), 2_000)

    const entries = log.list()
    expect(entries.map((entry) => entry.name)).toEqual(['second', 'first'])
    expect(entries.map((entry) => entry.seq)).toEqual([2, 1])

    log.clear()
    expect(log.list()).toEqual([])
    expect(log.push(record({ name: 'third' }), 3_000).seq).toBe(3)
  })

  it('超过上限淘汰最早的一条', () => {
    const log = new EventLog(3)

    for (let index = 0; index < 5; index += 1) log.push(record({ name: `e${index}` }), index)

    expect(log.list().map((entry) => entry.name)).toEqual(['e4', 'e3', 'e2'])
  })

  it('错误展平成文本，不持有原始错误对象', () => {
    const log = new EventLog(3)
    const error = new Error('boom')

    const entry = log.push(record({ error }), 1_000)

    expect(entry.error).toBe('Error: boom')
    expect(entry).not.toHaveProperty('errorObject')
  })

  it('没有归属插件时不写 pluginId 键', () => {
    const log = new EventLog(3)

    const withOwner = log.push(record({ pluginId: 'a#1' }), 1_000)
    const withoutOwner = log.push(record(), 1_000)

    expect(withOwner.pluginId).toBe('a#1')
    expect(Object.hasOwn(withoutOwner, 'pluginId')).toBe(false)
  })
})
