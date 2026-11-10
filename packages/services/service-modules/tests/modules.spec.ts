import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@lc/kernel'
import type { Context } from '@lc/kernel'
import type { ModuleService } from '@lc/contracts'
import modulesPlugin from '../src/index'

async function createModules(): Promise<{ app: Context; modules: ModuleService }> {
  const app = createApp({ grants: { 'service-modules': ['modules'] } })
  app.plugin(modulesPlugin)
  await app.runtime.whenIdle()

  return { app, modules: app.require<ModuleService>('modules') }
}

describe('模块加载服务', () => {
  it('未登记的 key 以 reject 结束，而不是静默返回 undefined', async () => {
    const { modules } = await createModules()

    await expect(modules.load('missing')).rejects.toThrow(/未登记的模块/)
  })

  it('同一 key 的并发请求只真正加载一次并共享结果', async () => {
    const load = vi.fn(async () => ({ value: 1 }))
    const { modules } = await createModules()
    modules.register({ key: 'p/a', load })

    const [first, second] = await Promise.all([modules.load('p/a'), modules.load('p/a')])

    expect(load).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
  })

  it('加载失败不写缓存，下一次调用允许重试', async () => {
    const load = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true })
    const { modules } = await createModules()
    modules.register({ key: 'p/b', load })

    await expect(modules.load('p/b')).rejects.toThrow('boom')
    await expect(modules.load('p/b')).resolves.toEqual({ ok: true })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('同 key 重复登记抛错；dispose 后可以重新登记并加载新实现', async () => {
    const { modules } = await createModules()
    const first = modules.register({ key: 'p/c', load: async () => 1 })

    expect(() => modules.register({ key: 'p/c', load: async () => 2 })).toThrow(/模块 key 重复/)

    first.dispose()
    expect(() => modules.register({ key: 'p/c', load: async () => 3 })).not.toThrow()
    await expect(modules.load('p/c')).resolves.toBe(3)
  })

  it('旧 Disposable 再次 dispose 不会删掉后来登记的加载器', async () => {
    const { modules } = await createModules()
    const first = modules.register({ key: 'p/d', load: async () => 1 })

    first.dispose()
    modules.register({ key: 'p/d', load: async () => 2 })
    first.dispose()

    await expect(modules.load('p/d')).resolves.toBe(2)
  })

  it('evict 只清指定插件前缀的登记与缓存', async () => {
    const { modules } = await createModules()
    modules.register({ key: 'p/e', load: async () => 1 })
    modules.register({ key: 'q/e', load: async () => 2 })
    await modules.load('p/e')

    modules.evict('p')

    await expect(modules.load('p/e')).rejects.toThrow(/未登记的模块/)
    await expect(modules.load('q/e')).resolves.toBe(2)
  })

  it('preload 单个 key 失败不阻塞其余模块', async () => {
    const { app, modules } = await createModules()
    modules.register({
      key: 'p/f',
      load: async () => {
        throw new Error('missing')
      },
    })
    modules.register({ key: 'p/g', load: async () => 7 })

    await expect(modules.preload(['p/f', 'p/g'])).resolves.toBeUndefined()
    expect(app.diagnostics.list().length).toBeGreaterThan(0)
    await expect(modules.load('p/g')).resolves.toBe(7)
  })
})
