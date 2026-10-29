import { describe, expect, it, vi } from 'vitest'
import { createApp, definePlugin } from '../src'

function providerPlugin(name: string, value: unknown) {
  return definePlugin({
    name,
    apply(ctx) {
      ctx.effect(() => ctx.provide(name, value))
    },
  })
}

describe('PluginRuntime 生命周期', () => {
  it('依赖缺失进入 pending，服务出现后自动激活', async () => {
    const app = createApp()
    let applied = 0

    const record = app.plugin(
      definePlugin({
        name: 'dependent',
        inject: ['greeter'],
        apply() {
          applied += 1
        },
      }),
    )

    await app.runtime.whenIdle()
    expect(record.state).toBe('pending')
    expect(applied).toBe(0)

    app.plugin(providerPlugin('greeter', { hi: true }))
    await app.runtime.whenIdle()

    expect(record.state).toBe('active')
    expect(applied).toBe(1)
  })

  it('服务消失时依赖者停用，服务恢复后重新 apply', async () => {
    const app = createApp()
    let applied = 0

    const provider = app.plugin(providerPlugin('db', { ok: 1 }))
    const consumer = app.plugin(
      definePlugin({
        name: 'db-consumer',
        inject: ['db'],
        apply() {
          applied += 1
        },
      }),
    )

    await app.runtime.whenIdle()
    expect(consumer.state).toBe('active')

    app.runtime.unload(provider.id)
    await app.runtime.whenIdle()

    expect(consumer.state).toBe('pending')
    expect(consumer.attempts).toBe(1)

    app.plugin(providerPlugin('db', { ok: 2 }))
    await app.runtime.whenIdle()

    expect(consumer.state).toBe('active')
    expect(applied).toBe(2)
  })

  it('卸载插件时逆序回收副作用与子插件', async () => {
    const app = createApp()
    const order: string[] = []

    const child = definePlugin({
      name: 'child',
      apply(ctx) {
        ctx.effect(() => ({ dispose: () => order.push('child') }))
      },
    })

    const parent = definePlugin({
      name: 'parent',
      apply(ctx) {
        ctx.effect(() => ({ dispose: () => order.push('parent-1') }))
        ctx.plugin(child)
        ctx.effect(() => ({ dispose: () => order.push('parent-2') }))
      },
    })

    const record = app.plugin(parent)
    await app.runtime.whenIdle()
    expect(record.state).toBe('active')

    app.runtime.unload(record.id)

    // 子插件先于父副作用回收，父副作用按注册逆序回收
    expect(order).toEqual(['child', 'parent-2', 'parent-1'])
    expect(record.state).toBe('disposed')
  })

  it('apply 抛错进入 failed，且不自动重试', async () => {
    const app = createApp()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const record = app.plugin(
      definePlugin({
        name: 'broken',
        apply() {
          throw new Error('boom')
        },
      }),
    )

    await app.runtime.whenIdle()
    await app.runtime.whenIdle()

    expect(record.state).toBe('failed')
    expect(record.error).toBeInstanceOf(Error)
    expect(record.attempts).toBe(1)
    consoleError.mockRestore()
  })

  it('父插件停用会连带卸载子插件', async () => {
    const app = createApp()
    const childDispose = vi.fn()

    const parent = definePlugin({
      name: 'parent-with-child',
      apply(ctx) {
        ctx.plugin(
          definePlugin({
            name: 'inner-child',
            apply(inner) {
              inner.effect(() => ({ dispose: childDispose }))
            },
          }),
        )
      },
    })

    const record = app.plugin(parent)
    await app.runtime.whenIdle()

    app.runtime.unload(record.id)
    expect(childDispose).toHaveBeenCalledTimes(1)
  })
})

describe('作用域与隔离', () => {
  it('fork 提供同名服务时遮蔽父级', () => {
    const app = createApp()
    const outer = { scope: 'app' }
    const inner = { scope: 'realm' }

    app.effect(() => app.provide('greeter', outer))
    const realm = app.fork()
    realm.effect(() => realm.provide('greeter', inner))

    expect(app.get('greeter')).toBe(outer)
    expect(realm.get('greeter')).toBe(inner)
  })

  it('isolate 只允许覆盖列出的服务，其余服务仍向上解析', () => {
    const app = createApp()
    const mock = { mock: true }

    app.effect(() => app.provide('api', { real: true }))
    app.effect(() => app.provide('cache', { real: true }))

    const preview = app.isolate(['api'], { api: mock })

    expect(preview.get('api')).toBe(mock)
    // 未列出的服务不允许在隔离层覆盖，但可从父作用域正常解析
    expect(preview.get('cache')).toEqual({ real: true })
    expect(() => preview.provide('cache', {})).toThrow(/隔离层/)
  })

  it('保留服务需要平台授权与 apiVersion', () => {
    const app = createApp()

    expect(() => app.provide('canvas', {})).toThrow(/保留/)
    expect(() => app.provide('canvas', {}, { grant: { pluginId: 'app', names: [] } })).toThrow(
      /保留/,
    )

    app.runtime.grant('app', ['canvas'])
    expect(() => app.provide('canvas', {})).toThrow(/apiVersion/)

    const handle = app.provide('canvas', { ok: true }, { apiVersion: '1.0' })
    expect(app.get('canvas')).toEqual({ ok: true })
    handle.dispose()
    expect(app.get('canvas')).toBeUndefined()
  })

  it('ctx.inject 在可选依赖出现/消失时绑定与回收', async () => {
    const app = createApp()
    const bind = vi.fn()
    const unbind = vi.fn()

    app.plugin(
      definePlugin({
        name: 'late-binding',
        apply(ctx) {
          ctx.inject(['notifier'], (scoped) => {
            bind()
            scoped.effect(() => ({ dispose: unbind }))
          })
        },
      }),
    )

    await app.runtime.whenIdle()
    expect(bind).not.toHaveBeenCalled()

    const provider = app.plugin(providerPlugin('notifier', { ok: true }))
    await app.runtime.whenIdle()
    expect(bind).toHaveBeenCalledTimes(1)

    app.runtime.unload(provider.id)
    await app.runtime.whenIdle()
    // 晚绑定回收走 services 观察 + 微任务，需要额外让出一轮事件循环
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unbind).toHaveBeenCalledTimes(1)
  })
})
