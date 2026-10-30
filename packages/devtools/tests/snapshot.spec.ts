import { describe, expect, it } from 'vitest'
import { createApp, definePlugin } from '@lc/kernel'
import type { PluginManifest } from '@lc/contracts'
import {
  buildCanvasView,
  buildConfigView,
  buildDependencies,
  collectPlugins,
  collectScopes,
  collectServices,
} from '../src/core/snapshot'

describe('作用域枚举', () => {
  it('只有根时得到一层作用域', () => {
    const app = createApp()

    expect(collectScopes(app)).toHaveLength(1)
    expect(collectScopes(app)[0]).toMatchObject({ id: 'root', label: '应用根', parentId: null })
  })

  it('fork 出来的画布层按 scope 链认父，而不是按 Context.children', () => {
    const app = createApp()
    const realm = app.fork()
    const canvas = realm.fork()

    const scopes = collectScopes(app, canvas)

    // realm 宿主没传进来，所以画布的父作用域只能是已知的最近一层
    expect(scopes.map((scope) => scope.id)).toEqual(['root', 'root/canvas'])
    expect(scopes[1]?.label).toBe('画布视图')
    expect(scopes[1]?.parentId).toBe('root')
  })
})

describe('插件树', () => {
  it('父插件先于子插件出现，并带上深度与父实例', async () => {
    const app = createApp()
    const parent = app.plugin(
      definePlugin({
        name: 'parent',
        apply(ctx) {
          ctx.plugin(definePlugin({ name: 'child', apply() {} }))
        },
      }),
    )
    app.plugin(definePlugin({ name: 'waiting', inject: ['nope'], apply() {} }))
    await app.runtime.whenIdle()

    const rows = collectPlugins(collectScopes(app))

    expect(rows.map((row) => row.name)).toEqual(['parent', 'child', 'waiting'])
    expect(rows[1]).toMatchObject({ depth: 1, parentId: parent.id, state: 'active' })
    expect(rows[2]).toMatchObject({
      depth: 0,
      parentId: null,
      state: 'pending',
      missing: ['nope'],
    })
    expect(rows[0]?.applyMs).toBeGreaterThanOrEqual(0)
  })

  it('停在 pending 的实例没有 Context，但它的兄弟与子树仍被完整展开', async () => {
    const app = createApp()
    app.plugin(
      definePlugin({
        name: 'holder',
        apply(ctx) {
          ctx.plugin(definePlugin({ name: 'inner', apply() {} }))
        },
      }),
    )
    await app.runtime.whenIdle()

    const scopes = collectScopes(app)
    const before = collectPlugins(scopes).map((row) => row.name)

    // pending 实例自己没有 Context，但它仍留在父级 children 里，树上看得见「起不来」的那一个
    const pending = app.plugin(
      definePlugin({ name: 'pending-holder', inject: ['later'], apply() {} }),
    )
    await app.runtime.whenIdle()
    expect(pending.state).toBe('pending')
    expect(collectPlugins(collectScopes(app)).map((row) => row.state)).toEqual([
      'active',
      'active',
      'pending',
    ])
    expect(before).toEqual(['holder', 'inner'])
  })

  it('装配失败时把错误展平到一行', async () => {
    const app = createApp()
    app.plugin(
      definePlugin({
        name: 'broken',
        apply() {
          throw new Error('apply 炸了')
        },
      }),
    )
    await app.runtime.whenIdle()
    await app.runtime.whenIdle()

    const row = collectPlugins(collectScopes(app))[0]

    expect(row?.state).toBe('failed')
    expect(row?.error).toBe('Error: apply 炸了')
  })

  it('没有 loader 服务时不编造清单信息', async () => {
    const app = createApp()
    app.plugin(definePlugin({ name: 'plain', apply() {} }))
    await app.runtime.whenIdle()

    expect(collectPlugins(collectScopes(app))[0]?.manifest).toBeUndefined()
  })

  it('嵌套插件注册的服务归属到它自己所在的那一层', async () => {
    const app = createApp()
    app.plugin(
      definePlugin({
        name: 'outer',
        apply(ctx) {
          ctx.plugin(
            definePlugin({
              name: 'inner',
              provides: ['inner-service'],
              apply(inner) {
                inner.provide('inner-service', { ok: true })
              },
            }),
          )
        },
      }),
    )
    await app.runtime.whenIdle()

    const scopes = collectScopes(app)
    const rows = collectPlugins(scopes)
    const services = collectServices(scopes)

    expect(services.map((row) => row.name)).toContain('inner-service')
    expect(rows.find((row) => row.name === 'inner')?.owned).toEqual(['inner-service'])
    expect(rows.find((row) => row.name === 'outer')?.owned).toEqual([])
  })
})

describe('服务表', () => {
  it('同层遮蔽给出实际生效层与被盖住的下层', async () => {
    const app = createApp()
    app.plugin(
      definePlugin({
        name: 'base',
        provides: ['counter'],
        apply(ctx) {
          ctx.provide('counter', { from: 'base' })
        },
      }),
    )
    await app.runtime.whenIdle()

    const fork = app.fork()
    fork.provide('counter', { from: 'fork' })

    const scopes = collectScopes(app, fork)
    const rows = collectServices(scopes).filter((row) => row.name === 'counter')

    expect(rows.map((row) => row.scopeId)).toEqual(['root', 'root/canvas'])
    expect(rows[0]?.chain).toHaveLength(1)
    expect(rows[1]?.chain.map((link) => [link.active, link.scopeId])).toEqual([
      [true, 'root/canvas'],
      [false, 'root'],
    ])
    expect(rows[1]?.summary).toBe('Object(1)')
  })

  it('保留服务被标记出来', async () => {
    const app = createApp()
    // 授权按 bootstrap 的做法在装配前签发，保留服务同时必须带 apiVersion
    app.runtime.grant('grant-holder', ['document'])
    app.plugin(
      definePlugin({
        name: 'grant-holder',
        apply(ctx) {
          ctx.provide('document', { id: 'doc' }, { apiVersion: '1.0' })
        },
      }),
    )
    await app.runtime.whenIdle()

    const row = collectServices(collectScopes(app)).find(
      (service) => service.name === 'document',
    )

    expect(row).toMatchObject({ reserved: true, apiVersion: '1.0', ownerName: 'grant-holder' })
  })
})

describe('依赖图', () => {
  it('互相等待的必需依赖形成一个环，并列出候选提供者', async () => {
    const app = createApp()
    app.plugin(definePlugin({ name: 'a', inject: ['svc-b'], provides: ['svc-a'], apply() {} }))
    app.plugin(definePlugin({ name: 'b', inject: ['svc-a'], provides: ['svc-b'], apply() {} }))
    await app.runtime.whenIdle()

    const scopes = collectScopes(app)
    const rows = collectPlugins(scopes)
    const view = buildDependencies(rows, scopes, collectServices(scopes))

    expect(view.blocked.map((row) => row.name)).toEqual(['a', 'b'])
    expect(view.cycles).toHaveLength(1)
    expect(view.cycles[0]?.map((id) => id.split('#')[0]).sort()).toEqual(['a', 'b'])
    expect(view.blocked[0]?.candidates[0]).toMatchObject({
      service: 'svc-b',
      providers: [{ name: 'b' }],
    })
    expect(view.edges.every((edge) => edge.to === null)).toBe(true)
  })

  it('可选依赖缺失不算阻塞，但边仍然可见', async () => {
    const app = createApp()
    app.plugin(
      definePlugin({
        name: 'optional-user',
        inject: { required: [], optional: ['telemetry-ish'] },
        apply() {},
      }),
    )
    await app.runtime.whenIdle()

    const scopes = collectScopes(app)
    const view = buildDependencies(collectPlugins(scopes), scopes, collectServices(scopes))

    expect(view.blocked).toEqual([])
    expect(view.edges).toEqual([
      {
        from: 'optional-user#1',
        fromName: 'optional-user',
        scopeId: 'root',
        service: 'telemetry-ish',
        required: false,
        to: null,
        toName: null,
      },
    ])
  })

  it('清单里声明了服务但尚未加载的插件也列为候选', async () => {
    const app = createApp()
    app.plugin(definePlugin({ name: 'needs-db', inject: ['db'], apply() {} }))
    await app.runtime.whenIdle()

    const scopes = collectScopes(app)
    const manifests: PluginManifest[] = [
      {
        name: 'db-provider',
        version: '0.1.0',
        engines: { lowcode: '^1.0.0' },
        provides: ['db'],
      },
      { name: 'unrelated', version: '0.1.0', engines: { lowcode: '^1.0.0' } },
    ]
    const view = buildDependencies(
      collectPlugins(scopes),
      scopes,
      collectServices(scopes),
      manifests,
    )

    expect(view.blocked[0]?.candidates[0]).toMatchObject({
      service: 'db',
      providers: [],
      unactivated: ['db-provider'],
    })
  })

  it('依赖已满足时指向真实提供者', async () => {
    const app = createApp()
    app.plugin(
      definePlugin({
        name: 'provider',
        provides: ['db'],
        apply(ctx) {
          ctx.provide('db', { ok: true })
        },
      }),
    )
    app.plugin(definePlugin({ name: 'consumer', inject: ['db'], apply() {} }))
    await app.runtime.whenIdle()

    const scopes = collectScopes(app)
    const view = buildDependencies(collectPlugins(scopes), scopes, collectServices(scopes))
    const edge = view.edges.find((item) => item.fromName === 'consumer')

    expect(edge).toMatchObject({
      service: 'db',
      to: 'provider#1',
      toName: 'provider',
      required: true,
    })
    expect(view.blocked).toEqual([])
  })
})

describe('配置视图', () => {
  it('展示原始配置、合并结果与覆盖来源', async () => {
    const app = createApp()
    app.intercept('configurable', { size: 20 })

    const record = app.plugin(
      definePlugin<{ size: number }>({
        name: 'configurable',
        schema: {
          parse: (input) => ({ size: (input as { size?: number }).size ?? 10 }),
        },
        apply() {},
      }),
      { size: 1 },
    )
    await app.runtime.whenIdle()

    const view = buildConfigView(collectScopes(app), record.id)

    expect(view).toMatchObject({
      id: record.id,
      name: 'configurable',
      raw: { size: 1 },
      resolved: { size: 20 },
      overrides: [{ scopeId: 'root', label: '应用根', patch: { size: 20 } }],
    })
  })

  it('未激活的实例没有解析结果，但原始配置仍在', async () => {
    const app = createApp()
    const record = app.plugin(definePlugin({ name: 'idle', inject: ['nope'], apply() {} }), {
      a: 1,
    })
    await app.runtime.whenIdle()

    const view = buildConfigView(collectScopes(app), record.id)

    expect(view).toMatchObject({ raw: { a: 1 }, resolved: undefined, overrides: [] })
  })

  it('实例不存在时返回 null', () => {
    const app = createApp()

    expect(buildConfigView(collectScopes(app), 'missing#1')).toBeNull()
  })
})

describe('画布视图', () => {
  it('没有画布上下文或没有画布服务时返回 null', () => {
    const app = createApp()

    expect(buildCanvasView(null)).toBeNull()
    expect(buildCanvasView(app.fork())).toBeNull()
  })
})
