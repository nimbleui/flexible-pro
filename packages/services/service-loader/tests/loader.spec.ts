import { describe, expect, it, vi } from 'vitest'
import { createApp, definePlugin } from '@lc/kernel'
import type { Context, Disposable } from '@lc/kernel'
import { installContextServices } from '@lc/contracts'
import type {
  LoaderService,
  ModuleEntry,
  ModuleService,
  PluginManifest,
  PluginPackage,
} from '@lc/contracts'
import loaderPlugin from '../src/index'

/** loader 只依赖 modules 契约，这里用最小实现，避免把测试变成多包集成测试 */
const fakeModules = definePlugin({
  name: 'fake-modules',
  apply(ctx) {
    const entries = new Map<string, () => Promise<unknown>>()
    const service: ModuleService = {
      register(entry: ModuleEntry): Disposable {
        entries.set(entry.key, entry.load)
        return { dispose: () => entries.delete(entry.key) }
      },
      async load<T = unknown>(key: string): Promise<T> {
        const load = entries.get(key)
        if (!load) throw new Error(`[modules] 未登记的模块: ${key}`)
        return (await load()) as T
      },
      async preload(): Promise<void> {},
      evict(): void {},
    }
    ctx.effect(() => ctx.provide('modules', service, { apiVersion: '1.0' }))
  },
})

async function createLoader(): Promise<{ app: Context; loader: LoaderService }> {
  installContextServices()
  const app = createApp({
    grants: {
      'fake-modules': ['modules'],
      'service-loader': ['loader', 'contribution'],
    },
  })
  app.plugin(fakeModules)
  app.plugin(loaderPlugin)
  await app.runtime.whenIdle()

  return { app, loader: app.require<LoaderService>('loader') }
}

function manifest(name: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name,
    version: '1.0.0',
    engines: { lowcode: '^1.0.0' },
    ...overrides,
  }
}

function makePackage(
  name: string,
  options: { declarative?: boolean; events?: string[]; definitionName?: string } = {},
): { pkg: PluginPackage; load: ReturnType<typeof vi.fn> } {
  const definitionName = options.definitionName ?? name
  const load = vi.fn(async () => ({
    default: definePlugin({ name: definitionName, apply() {} }),
  }))
  const pkg: PluginPackage = {
    manifest: manifest(name, {
      ...(options.declarative ? {} : { main: 'index.js' }),
      activationEvents: options.events ?? ['onStartup'],
    }),
    load,
  }

  return { pkg, load }
}

describe('装载器：登记与激活分离', () => {
  it('register 只登记元数据，不执行任何插件代码', async () => {
    const { loader } = await createLoader()
    const { pkg, load } = makePackage('p-1')

    loader.register(pkg)

    expect(load).not.toHaveBeenCalled()
    expect(loader.scan().map((item) => item.name)).toEqual(['p-1'])
    expect(loader.get('p-1')).toBe(pkg)
    expect(loader.isActivated('p-1')).toBe(false)
  })

  it('纯声明式插件（无 main）在激活事件下也不加载模块', async () => {
    const { loader } = await createLoader()
    const { pkg, load } = makePackage('p-2', { declarative: true })

    loader.register(pkg)
    await loader.ensureActivated('onStartup')

    expect(load).not.toHaveBeenCalled()
    expect(loader.isActivated('p-2')).toBe(false)
  })

  it('串行重复触发同一事件只装配一次', async () => {
    const { loader } = await createLoader()
    const { pkg, load } = makePackage('p-3')

    loader.register(pkg)
    await loader.ensureActivated('onStartup')
    await loader.ensureActivated('onStartup')

    expect(load).toHaveBeenCalledTimes(1)
    expect(loader.isActivated('p-3')).toBe(true)
  })

  it('manifest 与 definition 名字不一致时只记诊断，不影响调用方', async () => {
    const { app, loader } = await createLoader()
    const { pkg } = makePackage('p-4', { definitionName: 'some-other-name' })

    loader.register(pkg)
    await expect(loader.ensureActivated('onStartup')).resolves.toBeUndefined()

    expect(loader.isActivated('p-4')).toBe(false)
    expect(app.diagnostics.list().length).toBeGreaterThan(0)
  })

  it('onCanvasFeature:* 交给画布宿主，装载器直接跳过', async () => {
    const { loader } = await createLoader()
    const { pkg, load } = makePackage('p-5', { events: ['onCanvasFeature:drag'] })

    loader.register(pkg)
    await loader.ensureActivated('onCanvasFeature:drag')

    expect(load).not.toHaveBeenCalled()
    expect(loader.isActivated('p-5')).toBe(false)
  })

  it('同名重复登记抛错；dispose 后可重新登记', async () => {
    const { loader } = await createLoader()
    const { pkg } = makePackage('p-6')

    const registration = loader.register(pkg)
    expect(() => loader.register(makePackage('p-6').pkg)).toThrow(/重复登记/)

    registration.dispose()
    expect(loader.scan()).toHaveLength(0)
    expect(() => loader.register(makePackage('p-6').pkg)).not.toThrow()
  })

  it('未匹配任何清单的事件静默返回', async () => {
    const { loader } = await createLoader()
    loader.register(makePackage('p-7').pkg)

    await expect(loader.ensureActivated('onTypoEvent')).resolves.toBeUndefined()
    expect(loader.isActivated('p-7')).toBe(false)
  })

  it('并发触发同一事件只装配一次', async () => {
    const { loader } = await createLoader()
    const { pkg, load } = makePackage('p-8')
    loader.register(pkg)

    await Promise.all([
      loader.ensureActivated('onStartup'),
      loader.ensureActivated('onStartup'),
      loader.ensureActivated('onStartup'),
    ])

    expect(load).toHaveBeenCalledTimes(1)
    expect(loader.isActivated('p-8')).toBe(true)
  })

  it('加载期间撤销登记，任务回来后不会把插件挂回已失效的作用域', async () => {
    const { loader } = await createLoader()
    let resolveLoad!: (value: unknown) => void
    const load = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveLoad = resolve
        }),
    )
    const pkg: PluginPackage = {
      manifest: manifest('p-9', { main: 'index.js', activationEvents: ['onStartup'] }),
      load,
    }

    const registration = loader.register(pkg)
    const activation = loader.ensureActivated('onStartup')
    // ensureActivated 在微任务里才真正调用 load；先等加载开始，才能模拟「加载期间撤销」
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    registration.dispose()
    resolveLoad({ default: definePlugin({ name: 'p-9', apply() {} }) })
    await activation

    expect(load).toHaveBeenCalledTimes(1)
    expect(loader.isActivated('p-9')).toBe(false)
    expect(loader.scan()).toHaveLength(0)
  })
})
