import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, definePlugin } from '@lc/kernel'
import type { Context } from '@lc/kernel'
import { installContextServices } from '@lc/contracts'
import type { MaterialContribution, MaterialEntry, MaterialService } from '@lc/contracts'
import materialPlugin from '../src/index'

interface MaterialItem {
  plugin: string
  point: 'materials'
  value: MaterialContribution
}

/**
 * material 依赖 modules / contribution 两个外部服务。按最小 fake 原则只实现
 * 被生产代码实际调用的方法，不把测试变成多包集成测试。
 */
function createFakes(): {
  contribution: {
    list: (point: string) => MaterialItem[]
    onDidChange: (listener: () => void) => { dispose: () => void }
    add: (plugin: string, value: MaterialContribution) => void
    clear: () => void
  }
  modules: {
    load: <T = unknown>(key: string) => Promise<T>
    set: (key: string, load: () => Promise<unknown>) => void
  }
} {
  const items: MaterialItem[] = []
  const listeners = new Set<() => void>()
  const loaders = new Map<string, () => Promise<unknown>>()

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  return {
    contribution: {
      list: (point) => (point === 'materials' ? [...items] : []),
      onDidChange: (listener) => {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
      add: (plugin, value) => {
        items.push({ plugin, point: 'materials', value })
        notify()
      },
      clear: () => {
        items.length = 0
        notify()
      },
    },
    modules: {
      load: async <T = unknown>(key: string): Promise<T> => {
        const load = loaders.get(key)
        if (!load) throw new Error(`[modules] 未登记的模块: ${key}`)
        return (await load()) as T
      },
      set: (key, load) => {
        loaders.set(key, load)
      },
    },
  }
}

async function createMaterial(): Promise<{
  app: Context
  material: MaterialService
  fakes: ReturnType<typeof createFakes>
}> {
  installContextServices()
  const fakes = createFakes()
  const app = createApp({
    grants: {
      'fake-contribution': ['contribution'],
      'fake-modules': ['modules'],
      'service-material': ['material'],
    },
  })

  app.plugin(
    definePlugin({
      name: 'fake-contribution',
      apply(ctx) {
        ctx.effect(() => ctx.provide('contribution', fakes.contribution, { apiVersion: '1.0' }))
      },
    }),
  )
  app.plugin(
    definePlugin({
      name: 'fake-modules',
      apply(ctx) {
        ctx.effect(() => ctx.provide('modules', fakes.modules, { apiVersion: '1.0' }))
      },
    }),
  )
  await app.runtime.whenIdle()

  app.plugin(materialPlugin)
  await app.runtime.whenIdle()

  return { app, material: app.require<MaterialService>('material'), fakes }
}

function makeContribution(overrides: Partial<MaterialContribution> = {}): MaterialContribution {
  return {
    name: 'lc.box',
    title: '盒子',
    category: '基础',
    props: {},
    module: 'box.js',
    ...overrides,
  }
}

function makeEntry(overrides: Partial<MaterialEntry> = {}): MaterialEntry {
  return {
    ...makeContribution(),
    plugin: 'manual',
    moduleKey: 'manual/box.js',
    ...overrides,
  }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('service-material：元数据装配与懒加载', () => {
  it('初始生效表为空；首次 rebuild 触发一次 version，未登记名字返回 undefined', async () => {
    const { app, material } = await createMaterial()

    expect(material.list()).toEqual([])
    expect(material.version).toBe(1)
    expect(material.get('missing')).toBeUndefined()
    await expect(material.ensure('missing')).resolves.toBeUndefined()

    app.dispose()
  })

  it('运行时 register/get/list：同名重复抛错，dispose 后条目消失', async () => {
    const { app, material } = await createMaterial()
    const entry = makeEntry()

    const registration = material.register(entry)
    expect(material.get('lc.box')?.plugin).toBe('manual')
    expect(material.list()).toHaveLength(1)
    expect(() => material.register(makeEntry())).toThrow(/物料重复注册/)

    registration.dispose()
    expect(material.get('lc.box')).toBeUndefined()

    app.dispose()
  })

  it('贡献优先级始终高于运行时 manual 条目', async () => {
    const { app, material, fakes } = await createMaterial()

    fakes.contribution.add('p1', makeContribution({ module: 'contrib.js' }))
    material.register(makeEntry({ moduleKey: 'manual/box.js' }))

    expect(material.get('lc.box')?.plugin).toBe('p1')
    expect(material.get('lc.box')?.moduleKey).toBe('p1/contrib.js')
    expect(material.list()).toHaveLength(1)

    app.dispose()
  })

  it('同名贡献按 priority 决胜：高优先级覆盖，同优先级先注册者胜出', async () => {
    const { app, material, fakes } = await createMaterial()

    fakes.contribution.add('p-low', makeContribution({ priority: 1 }))
    fakes.contribution.add('p-high', makeContribution({ priority: 8 }))
    expect(material.get('lc.box')?.plugin).toBe('p-high')

    fakes.contribution.clear()
    fakes.contribution.add('p-first', makeContribution({ priority: 3 }))
    fakes.contribution.add('p-second', makeContribution({ priority: 3 }))
    expect(material.get('lc.box')?.plugin).toBe('p-first')

    app.dispose()
  })

  it('贡献变化触发 rebuild 后，manual 条目不会丢失', async () => {
    const { app, material, fakes } = await createMaterial()

    material.register(makeEntry({ name: 'lc.manual', moduleKey: 'manual/manual.js' }))
    fakes.contribution.add('p1', makeContribution({ name: 'lc.contrib', module: 'c.js' }))

    expect(material.get('lc.manual')?.plugin).toBe('manual')
    expect(material.get('lc.contrib')?.plugin).toBe('p1')
    expect(material.list()).toHaveLength(2)

    app.dispose()
  })

  it('ensure 并发共享同一个 Promise，成功后缓存解析结果', async () => {
    const { app, material, fakes } = await createMaterial()
    fakes.contribution.add('p1', makeContribution())
    const component = { name: 'Box' }
    let loads = 0
    fakes.modules.set('p1/box.js', async () => {
      loads += 1
      return { components: { 'lc.box': component } }
    })

    const first = material.ensure('lc.box')
    const second = material.ensure('lc.box')
    expect(first).toBe(second)

    const resolved = await first
    expect(resolved?.component).toBe(component)
    expect(await second).toBe(resolved)
    expect(loads).toBe(1)

    app.dispose()
  })

  it('ensure 支持 components 名字表与 default 兜底两种导出形状', async () => {
    const { app, material, fakes } = await createMaterial()
    const defaultComponent = { name: 'DefaultBox' }
    fakes.contribution.add('p1', makeContribution())
    fakes.modules.set('p1/box.js', async () => ({ default: defaultComponent }))

    expect((await material.ensure('lc.box'))?.component).toBe(defaultComponent)

    app.dispose()
  })

  it('模块加载失败返回 undefined、记诊断且不缓存（可重试）', async () => {
    const { app, material, fakes } = await createMaterial()
    fakes.contribution.add('p1', makeContribution())
    let loads = 0
    fakes.modules.set('p1/box.js', async () => {
      loads += 1
      throw new Error('模块下载失败')
    })

    await expect(material.ensure('lc.box')).resolves.toBeUndefined()
    await expect(material.ensure('lc.box')).resolves.toBeUndefined()
    expect(loads).toBe(2)
    expect(app.diagnostics.list().some((record) => record.scope === 'material')).toBe(true)

    app.dispose()
  })

  it('模块缺组件导出时返回 undefined，删缓存后下一次可重试成功', async () => {
    const { app, material, fakes } = await createMaterial()
    fakes.contribution.add('p1', makeContribution())
    const component = { name: 'Recovered' }
    let attempts = 0
    fakes.modules.set('p1/box.js', async () => {
      attempts += 1
      return attempts === 1 ? { default: undefined } : { default: component }
    })

    await expect(material.ensure('lc.box')).resolves.toBeUndefined()
    expect((await material.ensure('lc.box'))?.component).toBe(component)
    expect(attempts).toBe(2)

    app.dispose()
  })

  it('onDidChange 在 register / 贡献变化 / dispose 时通知，退订后停止', async () => {
    const { app, material, fakes } = await createMaterial()
    const listener = vi.fn()
    const subscription = material.onDidChange(listener)

    const registration = material.register(makeEntry({ name: 'lc.watch' }))
    expect(listener).toHaveBeenCalledTimes(1)

    fakes.contribution.add('p1', makeContribution({ name: 'lc.watch' }))
    expect(listener).toHaveBeenCalledTimes(2)

    subscription.dispose()
    registration.dispose()
    expect(listener).toHaveBeenCalledTimes(2)

    app.dispose()
  })
})
