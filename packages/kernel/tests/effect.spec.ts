import { describe, expect, it, vi } from 'vitest'
import { EffectScope } from '../src/effect'

describe('EffectScope', () => {
  it('逆序回收副作用', () => {
    const order: string[] = []
    const scope = new EffectScope()

    scope.add(() => order.push('first'))
    scope.add(() => order.push('second'))
    scope.add(() => order.push('third'))
    scope.dispose()

    expect(order).toEqual(['third', 'second', 'first'])
  })

  it('关闭后新增副作用立即回收且不执行 factory', () => {
    const scope = new EffectScope()
    const factory = vi.fn(() => ({ dispose: vi.fn() }))
    scope.dispose()

    const item = scope.effect(factory)
    const dispose = vi.fn()
    scope.add(dispose)

    expect(factory).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(item.dispose).toBeTypeOf('function')
  })

  it('回收过程中单个副作用抛错不阻断其余副作用', () => {
    const scope = new EffectScope()
    const dispose = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    scope.add(dispose)
    scope.add(() => {
      throw new Error('boom')
    })

    expect(() => scope.dispose()).not.toThrow()
    expect(dispose).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })
})
