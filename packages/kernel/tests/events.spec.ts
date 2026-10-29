import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '../src/events'

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
