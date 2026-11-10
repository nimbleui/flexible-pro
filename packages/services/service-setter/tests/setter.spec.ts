import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@lc/kernel'
import type { Context } from '@lc/kernel'
import { installContextServices } from '@lc/contracts'
import type { PropType } from '@lc/schema'
import type { SetterEntry, SetterService } from '@lc/contracts'
import setterPlugin from '../src/index'

const ALL_PROP_TYPES: readonly PropType[] = [
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'enum',
  'event',
  'slot',
  'json',
  'color',
  'icon',
  'style',
  'function',
]

/** BUILTIN_SETTERS 的注册顺序（src/index.ts:6-20），list() 不打乱它 */
const BUILTIN_ORDER: readonly string[] = [
  'setter.string',
  'setter.number',
  'setter.boolean',
  'setter.color',
  'setter.enum',
  'setter.icon',
  'setter.json',
  'setter.object',
  'setter.array',
  'setter.style',
  'setter.event',
  'setter.slot',
  'setter.function',
]

async function createSetter(): Promise<{ app: Context; setter: SetterService }> {
  installContextServices()
  const app = createApp({ grants: { 'service-setter': ['setter'] } })
  app.plugin(setterPlugin)
  await app.runtime.whenIdle()

  return { app, setter: app.require<SetterService>('setter') }
}

function entry(id: string, propType: PropType, priority?: number): SetterEntry {
  return {
    id,
    propType,
    kind: 'text',
    ...(priority === undefined ? {} : { priority }),
  }
}

describe('service-setter：内置映射与优先级解析', () => {
  it('内置 13 个设置器覆盖全部 PropType，version 等于注册次数', async () => {
    const { app, setter } = await createSetter()

    expect(setter.list()).toHaveLength(13)
    expect(setter.version).toBe(13)
    for (const propType of ALL_PROP_TYPES) {
      expect(setter.resolve(propType)?.id).toBe(`setter.${propType}`)
    }

    app.dispose()
  })

  it('resolve 按 priority 返回同类型中最高优先级的条目', async () => {
    const { app, setter } = await createSetter()

    setter.register(entry('custom.low', 'string', 1))
    const high = entry('custom.high', 'string', 10)
    setter.register(high)

    expect(setter.resolve('string')).toBe(high)
    expect(setter.get('custom.high')).toBe(high)

    app.dispose()
  })

  it('同 priority 时先注册者胜出（稳定排序）', async () => {
    const { app, setter } = await createSetter()

    const first = entry('custom.first', 'number', 5)
    const second = entry('custom.second', 'number', 5)
    setter.register(first)
    setter.register(second)

    expect(setter.resolve('number')).toBe(first)

    app.dispose()
  })

  it('内置条目 priority 缺省为 0，任何正优先级插件条目都能覆盖它', async () => {
    const { app, setter } = await createSetter()

    expect(setter.resolve('color')?.id).toBe('setter.color')
    const custom = entry('custom.color', 'color', 1)
    setter.register(custom)
    expect(setter.resolve('color')).toBe(custom)

    app.dispose()
  })

  it('重复 id 注册抛错，且不覆盖已有条目', async () => {
    const { app, setter } = await createSetter()
    const first = entry('custom.dup', 'string', 3)

    setter.register(first)
    expect(() => setter.register(entry('custom.dup', 'number', 9))).toThrow(/设置器 id 重复/)
    expect(setter.get('custom.dup')).toBe(first)
    expect(setter.resolve('number')?.id).toBe('setter.number')

    app.dispose()
  })

  it('dispose 按实例引用比对，迟到的旧句柄不会删掉新注册的同名条目', async () => {
    const { app, setter } = await createSetter()
    const first = entry('custom.reuse', 'string', 1)
    const second = entry('custom.reuse', 'string', 2)

    const registration = setter.register(first)
    registration.dispose()
    setter.register(second)
    registration.dispose()

    expect(setter.get('custom.reuse')).toBe(second)
    expect(setter.resolve('string')).toBe(second)

    app.dispose()
  })

  it('register / dispose 各自触发 onDidChange 并自增 version', async () => {
    const { app, setter } = await createSetter()
    const startVersion = setter.version
    const listener = vi.fn()
    const subscription = setter.onDidChange(listener)

    const registration = setter.register(entry('custom.watch', 'string', 1))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(setter.version).toBe(startVersion + 1)

    registration.dispose()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(setter.version).toBe(startVersion + 2)

    subscription.dispose()
    setter.register(entry('custom.after', 'string', 1))
    expect(listener).toHaveBeenCalledTimes(2)

    app.dispose()
  })

  it('list() 保持注册顺序，内置条目在前', async () => {
    const { app, setter } = await createSetter()

    setter.register(entry('custom.a', 'string', 1))
    setter.register(entry('custom.b', 'number', 1))

    const ids = setter.list().map((item) => item.id)
    expect(ids.slice(0, 13)).toEqual([...BUILTIN_ORDER])
    expect(ids.slice(13)).toEqual(['custom.a', 'custom.b'])
    expect(setter.get('not-registered')).toBeUndefined()

    app.dispose()
  })
})
