import { describe, expect, it } from 'vitest'
import type {
  ActionHandler,
  ActionHandlerInput,
  DataSourceService,
  NavigationService,
  StateService,
  ToastService,
} from '@lc/contracts'
import type { ActionDeclaration } from '@lc/schema'
import { createBusinessHandlers } from '../src'
import type { BusinessHandlerDeps } from '../src'

/** 记录型状态服务替身；`declared` 模拟页面变量声明表 */
function makeState(declared: readonly string[] = ['keyword', 'list']) {
  const values = new Map<string, unknown>()
  const state: StateService = {
    snapshot: () => Object.fromEntries(values),
    get: (key) => values.get(key),
    has: (key) => declared.includes(key),
    set(key, value) {
      values.set(key, value)
    },
    reset(key) {
      if (key === undefined) values.clear()
      else values.delete(key)
    },
    onDidChange: () => ({ dispose: () => {} }),
  }

  return { state, values }
}

/** 数据源服务替身；`fetch` 不 reject，与真实契约一致 */
function makeDataSource(result: { data?: unknown; error?: string | null } = {}) {
  const fetched: string[] = []
  const service: DataSourceService = {
    stateOf: () => ({
      data: result.data,
      loading: false,
      loaded: !result.error,
      error: result.error ?? null,
    }),
    states: () => ({}),
    async fetch(id) {
      fetched.push(id)
    },
    // 动作执行器不推请求默认值，替身只需保住契约形状
    setRequestDefaults: () => {},
    onDidChange: () => ({ dispose: () => {} }),
  }

  return { service, fetched }
}

/** 一次处理器调用的替身输入 */
function makeInput(type: string, config: Record<string, unknown>): ActionHandlerInput {
  const action: ActionDeclaration = { id: 'a1', type, config }
  return {
    action,
    config,
    scope: {},
    runAction: async () => ({ kind: 'continue' as const }),
  }
}

/** 装配依赖：默认只有状态与数据源，宿主能力按需补 */
function makeDeps(overrides: Partial<BusinessHandlerDeps> = {}): BusinessHandlerDeps {
  return {
    pageState: makeState().state,
    dataSource: makeDataSource().service,
    getService: () => undefined,
    ...overrides,
  }
}

/**
 * 执行指定类型的动作。
 *
 * 每次都重新 `createBusinessHandlers`：处理器不持有跨调用状态，这样各用例互不污染。
 */
async function execute(
  deps: BusinessHandlerDeps,
  type: string,
  config: Record<string, unknown>,
): Promise<void> {
  const handlers: readonly ActionHandler[] = createBusinessHandlers(deps)
  const handler = handlers.find((item) => item.type === type)
  if (!handler) throw new Error(`内置处理器清单里没有 "${type}"`)

  await handler.execute(makeInput(type, config))
}

describe('state.set / state.reset', () => {
  it('写入已声明的变量', async () => {
    const { state, values } = makeState()

    await execute(makeDeps({ pageState: state }), 'state.set', { key: 'keyword', value: 'abc' })

    expect(values.get('keyword')).toBe('abc')
  })

  it('写入未声明的变量时抛错，而不是静默丢弃', async () => {
    /**
     * 未声明的名字进不了表达式作用域，静默写入等于「面板显示执行成功但界面没反应」。
     * 抛错才能让动作的 `onError` 策略生效，也才能被调试面板看见。
     */
    const { state } = makeState()

    await expect(
      execute(makeDeps({ pageState: state }), 'state.set', { key: 'typoName', value: 1 }),
    ).rejects.toThrow('页面未声明变量 "typoName"')
  })

  it('缺变量名时报出带动作类型的原因为谁缺', async () => {
    await expect(execute(makeDeps(), 'state.set', { value: 1 })).rejects.toThrow(
      'state.set 缺少必填配置 "key"',
    )
  })

  it('reset 带变量名只清那一个', async () => {
    const { state, values } = makeState()
    values.set('keyword', 'a')
    values.set('list', [1])

    await execute(makeDeps({ pageState: state }), 'state.reset', { key: 'keyword' })

    expect(values.has('keyword')).toBe(false)
    expect(values.has('list')).toBe(true)
  })

  it('reset 不带变量名清全部', async () => {
    const { state, values } = makeState()
    values.set('keyword', 'a')

    await execute(makeDeps({ pageState: state }), 'state.reset', {})

    expect(values.size).toBe(0)
  })
})

describe('dataSource.fetch', () => {
  it('取数成功后把结果写进 assignTo 变量', async () => {
    const { state, values } = makeState()
    const { service, fetched } = makeDataSource({ data: [{ id: 1 }] })

    await execute(makeDeps({ pageState: state, dataSource: service }), 'dataSource.fetch', {
      dataSourceId: 'users',
      assignTo: 'list',
    })

    expect(fetched).toEqual(['users'])
    expect(values.get('list')).toEqual([{ id: 1 }])
  })

  it('取数失败时抛错', async () => {
    /**
     * 关键一条：`DataSourceService.fetch` 按契约不 reject，失败只写在状态对象上。
     * 处理器若不主动读 `error`，请求失败会被当成成功，后续动作就在过期数据上继续跑。
     */
    const { service } = makeDataSource({ error: '网络不可达' })

    await expect(
      execute(makeDeps({ dataSource: service }), 'dataSource.fetch', { dataSourceId: 'users' }),
    ).rejects.toThrow('数据源 "users" 取数失败：网络不可达')
  })

  it('不写 assignTo 时只取数，不碰状态', async () => {
    const { state, values } = makeState()
    const { service } = makeDataSource({ data: 1 })

    await execute(makeDeps({ pageState: state, dataSource: service }), 'dataSource.fetch', {
      dataSourceId: 'users',
    })

    expect(values.size).toBe(0)
  })

  it('assignTo 指向未声明的变量时抛错', async () => {
    const { service } = makeDataSource({ data: 1 })

    await expect(
      execute(makeDeps({ dataSource: service }), 'dataSource.fetch', {
        dataSourceId: 'users',
        assignTo: 'ghost',
      }),
    ).rejects.toThrow('页面未声明变量 "ghost"')
  })
})

describe('ui.toast', () => {
  it('宿主没提供提示服务时抛错', async () => {
    await expect(execute(makeDeps(), 'ui.toast', { message: '你好' })).rejects.toThrow(
      '当前宿主未提供提示服务',
    )
  })

  it('按级别弹提示，并把非字符串内容收敛成文本', async () => {
    const shown: [string, string | undefined][] = []
    const toast: ToastService = { show: (message, level) => shown.push([message, level]) }

    await execute(makeDeps({ toast }), 'ui.toast', { message: 42, level: 'success' })

    expect(shown).toEqual([['42', 'success']])
  })

  it('级别不在候选里时按提示级弹出，而不是不弹', async () => {
    const shown: (string | undefined)[] = []
    const toast: ToastService = { show: (_message, level) => shown.push(level) }

    await execute(makeDeps({ toast }), 'ui.toast', { message: 'x', level: 'bogus' })

    expect(shown).toEqual(['info'])
  })
})

describe('navigation.go', () => {
  it('宿主没提供路由服务时抛错', async () => {
    await expect(execute(makeDeps(), 'navigation.go', { to: '/detail' })).rejects.toThrow(
      '当前宿主未提供路由服务',
    )
  })

  it('带上 replace 选项跳转', async () => {
    const calls: [string, { replace?: boolean } | undefined][] = []
    const navigation: NavigationService = { go: (to, options) => calls.push([to, options]) }

    await execute(makeDeps({ navigation }), 'navigation.go', { to: '/detail/1', replace: true })

    expect(calls).toEqual([['/detail/1', { replace: true }]])
  })

  it('缺目标路径时报错', async () => {
    const navigation: NavigationService = { go: () => {} }

    await expect(execute(makeDeps({ navigation }), 'navigation.go', {})).rejects.toThrow(
      'navigation.go 缺少必填配置 "to"',
    )
  })
})

describe('plugin.invoke', () => {
  /** 只提供 `greet` 方法的业务插件服务 */
  function makePluginService() {
    const received: unknown[][] = []
    return {
      received,
      service: {
        greet: (...args: unknown[]) => {
          received.push(args)
        },
      },
    }
  }

  function depsFor(target: unknown): BusinessHandlerDeps {
    return makeDeps({ getService: (name) => (name === 'my-plugin' ? target : undefined) })
  }

  it('数组参数按位置展开', async () => {
    const { service, received } = makePluginService()

    await execute(depsFor(service), 'plugin.invoke', {
      service: 'my-plugin',
      method: 'greet',
      args: ['a', 'b'],
    })

    expect(received).toEqual([['a', 'b']])
  })

  it('非数组参数作为单个参数传入', async () => {
    const { service, received } = makePluginService()

    await execute(depsFor(service), 'plugin.invoke', {
      service: 'my-plugin',
      method: 'greet',
      args: { id: 1 },
    })

    expect(received).toEqual([[{ id: 1 }]])
  })

  it('不给参数时空调用', async () => {
    const { service, received } = makePluginService()

    await execute(depsFor(service), 'plugin.invoke', { service: 'my-plugin', method: 'greet' })

    expect(received).toEqual([[]])
  })

  it('拒绝调用平台保留服务', async () => {
    /**
     * `ServiceGrant` 只约束 `provide`，不约束 `get`。这里不拦的话，一条页面动作就能
     * 拿到 `document` 服务改写文档——协议里「只按声明调用插件服务，不允许直接访问
     * 插件内部对象」靠这一行落地。
     */
    await expect(
      execute(depsFor({ commit: () => {} }), 'plugin.invoke', {
        service: 'document',
        method: 'commit',
      }),
    ).rejects.toThrow('不允许调用平台保留服务 "document"')
  })

  it('服务不存在时报「没有可调用的方法」', async () => {
    await expect(
      execute(makeDeps(), 'plugin.invoke', { service: 'ghost', method: 'run' }),
    ).rejects.toThrow('服务 "ghost" 上没有可调用的方法 "run"')
  })

  it('方法存在但不是函数时同样抛错', async () => {
    await expect(
      execute(depsFor({ version: '1.0' }), 'plugin.invoke', {
        service: 'my-plugin',
        method: 'version',
      }),
    ).rejects.toThrow('服务 "my-plugin" 上没有可调用的方法 "version"')
  })
})

describe('处理器清单', () => {
  it('覆盖 6 个需要外部能力的内置动作', () => {
    expect(createBusinessHandlers(makeDeps()).map((handler) => handler.type)).toEqual([
      'state.set',
      'state.reset',
      'dataSource.fetch',
      'navigation.go',
      'ui.toast',
      'plugin.invoke',
    ])
  })

  it('宿主能力晚到也能被用上：动作执行时才读提示服务', async () => {
    /**
     * 装配层把 toast 传成 getter，这条用例钉住「处理器不在创建时快照宿主依赖」——
     * 宿主的提示服务可能在本 Realm 建立之后才注册。
     *
     * 这里手工构造 deps 而不是走 `makeDeps`：展开运算符会在合并那一刻求值 getter，
     * 等于把要验证的惰性语义当场抹掉。
     */
    const host: { toast?: ToastService } = {}
    const shown: string[] = []
    const deps: BusinessHandlerDeps = {
      pageState: makeState().state,
      dataSource: makeDataSource().service,
      getService: () => undefined,
      get toast() {
        return host.toast
      },
    }

    host.toast = { show: (message) => shown.push(message) }
    await execute(deps, 'ui.toast', { message: '后来的提示' })

    expect(shown).toEqual(['后来的提示'])
  })
})
