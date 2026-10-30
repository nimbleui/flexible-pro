import { describe, expect, it, vi } from 'vitest'
import type { EventDispatchRecord, PluginRecord } from '../src'
import { EventBus } from '../src/events'

function createRecord(id: string): PluginRecord {
  return {
    id,
    name: id.split('#')[0] ?? id,
    state: 'active',
    rawConfig: undefined,
    context: null,
    parent: null,
    inject: { required: [], optional: [] },
    provides: [],
    attempts: 1,
  }
}

describe('EventBus', () => {
  it('emit 隔离监听器错误', () => {
    const bus = new EventBus()
    const received: number[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    bus.add('tick', () => {
      throw new Error('boom')
    })
    bus.add('tick', (value) => received.push(value))

    bus.emit('tick', 1)

    expect(received).toEqual([1])
    consoleError.mockRestore()
  })

  it('prepend 优先于 priority，同组按 priority 降序', () => {
    const bus = new EventBus()
    const order: string[] = []

    bus.add('tick', () => order.push('normal-0'))
    bus.add('tick', () => order.push('high'), { priority: 10 })
    bus.add('tick', () => order.push('prepend'), { prepend: true, priority: -10 })

    bus.emit('tick', 0)

    expect(order).toEqual(['prepend', 'high', 'normal-0'])
  })

  it('waterfall 逐级传递返回值', async () => {
    const bus = new EventBus()
    bus.add('pipeline', (value) => value + 1)
    bus.add('pipeline', (value) => value * 2)

    await expect(bus.waterfall('pipeline', 1)).resolves.toBe(4)
  })

  it('bail 返回第一个非 undefined 结果', async () => {
    const bus = new EventBus()
    bus.add('pick', () => undefined)
    bus.add('pick', () => 'hit')
    bus.add('pick', () => 'late')

    await expect(bus.bail<string>('pick')).resolves.toBe('hit')
  })

  it('dispose 后不再收到事件', () => {
    const bus = new EventBus()
    const listener = vi.fn()
    const handle = bus.add('tick', listener)

    bus.emit('tick', 1)
    handle.dispose()
    bus.emit('tick', 2)

    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('事件监视器', () => {
  it('每个监听器产生一条记录，并带上归属插件与本次监听器数量', () => {
    const bus = new EventBus()
    const records: EventDispatchRecord[] = []
    bus.monitor((record) => records.push(record))

    bus.add('tick', () => {}, {}, createRecord('a#1'))
    bus.add('tick', () => {})
    bus.emit('tick', 1)

    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      name: 'tick',
      mode: 'emit',
      pluginId: 'a#1',
      listenerCount: 2,
    })
    expect(records[1]?.pluginId).toBeUndefined()
    expect(records[1]?.duration).toBeGreaterThanOrEqual(0)
  })

  it('无人监听的事件也留一条记录，listenerCount 为 0', () => {
    const bus = new EventBus()
    const records: EventDispatchRecord[] = []
    bus.monitor((record) => records.push(record))

    bus.emit('nobody-listens', 1)

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ name: 'nobody-listens', mode: 'emit', listenerCount: 0 })
    expect(records[0]?.pluginId).toBeUndefined()
  })

  it('抛错的监听器记录 error，其余监听器照常执行', () => {
    const bus = new EventBus()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const records: EventDispatchRecord[] = []
    const later = vi.fn()
    bus.monitor((record) => records.push(record))

    bus.add('tick', () => {
      throw new Error('boom')
    })
    bus.add('tick', later)
    bus.emit('tick')

    expect(later).toHaveBeenCalledTimes(1)
    expect(records[0]?.error).toBeInstanceOf(Error)
    expect(records[1]?.error).toBeUndefined()
    consoleError.mockRestore()
  })

  it('waterfall 上报抛错后继续向外抛', async () => {
    const bus = new EventBus()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const records: EventDispatchRecord[] = []
    bus.monitor((record) => records.push(record))

    bus.add('pipeline', () => {
      throw new Error('broken')
    })

    await expect(bus.waterfall('pipeline', 1)).rejects.toThrow('broken')
    expect(records[0]).toMatchObject({ mode: 'waterfall' })
    expect(records[0]?.error).toBeInstanceOf(Error)
    consoleError.mockRestore()
  })

  it('监视器自身抛错不影响分发，注销后停止记录', () => {
    const bus = new EventBus()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const received: number[] = []
    const handle = bus.monitor(() => {
      throw new Error('monitor down')
    })

    bus.add('tick', (value) => received.push(value))
    bus.emit('tick', 1)
    handle.dispose()
    bus.emit('tick', 2)

    expect(received).toEqual([1, 2])
    expect(consoleError).toHaveBeenCalledWith('[lc] 事件监视器执行失败', expect.any(Error))
    consoleError.mockRestore()
  })

  it('parallel 与 serial 记录各自的 mode', async () => {
    const bus = new EventBus()
    const modes: string[] = []
    bus.monitor((record) => modes.push(record.mode))

    bus.add('tick', async () => {})
    await bus.parallel('tick')
    await bus.serial('tick')
    await bus.bail('tick')

    expect(modes).toEqual(['parallel', 'serial', 'bail'])
  })
})
