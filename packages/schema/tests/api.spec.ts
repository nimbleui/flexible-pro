import { describe, expect, it } from 'vitest'
import type { DataSourceSchemaDef, PageApiBinding, PageSchema, ProjectApi } from '../src/index'
import {
  SCHEMA_VERSION,
  apiToRestConfig,
  applyApiBindings,
  findBindingIdConflicts,
  findUnresolvedBindings,
  joinApiUrl,
  resolveApiBinding,
  stripApiBindings,
} from '../src/index'

function makeApi(overrides: Partial<ProjectApi> = {}): ProjectApi {
  return {
    id: 'api-user-list',
    projectId: 'project-1',
    name: '用户列表',
    method: 'GET',
    path: '/users',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeSchema(
  datasources: DataSourceSchemaDef[] | undefined,
  apis: PageApiBinding[] | undefined,
): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        componentName: 'Box',
        layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 100, height: 100 } },
      },
    },
    components: [],
    ...(datasources === undefined ? {} : { datasources }),
    ...(apis === undefined ? {} : { apis }),
  }
}

describe('接口地址拼接', () => {
  it('相对路径按项目前缀拼接，多余斜杠只保留一个', () => {
    expect(joinApiUrl('https://api.test/base', '/users')).toBe('https://api.test/base/users')
    expect(joinApiUrl('https://api.test/base/', 'users')).toBe('https://api.test/base/users')
    expect(joinApiUrl('https://api.test/base/', '/users')).toBe('https://api.test/base/users')
  })

  it('没有前缀时原样返回，保留相对地址交给同源请求', () => {
    expect(joinApiUrl(undefined, '/api/users')).toBe('/api/users')
    expect(joinApiUrl('   ', '/api/users')).toBe('/api/users')
  })

  it('绝对地址与协议相对地址不拼前缀', () => {
    expect(joinApiUrl('https://api.test', 'https://other.test/x')).toBe('https://other.test/x')
    expect(joinApiUrl('https://api.test', '//cdn.test/x.json')).toBe('//cdn.test/x.json')
  })

  it('路径为空即无效地址，返回空串而不是前缀', () => {
    expect(joinApiUrl('https://api.test', '  ')).toBe('')
  })
})

describe('接口定义展开', () => {
  it('同一份定义每次展开出的配置指纹字符串一致', () => {
    const api = makeApi({ headers: { 'X-A': '1' }, params: { page: '2' }, body: { q: 1 } })
    const first = JSON.stringify({ type: 'rest', config: apiToRestConfig(api) })
    const second = JSON.stringify({ type: 'rest', config: apiToRestConfig(api) })

    expect(first).toBe(second)
  })

  it('空的对象字段不落键，避免展开产物带着一堆 undefined', () => {
    const config = apiToRestConfig(makeApi({ headers: {}, params: {} }))

    expect(Object.keys(config)).toEqual(['kind', 'url', 'method'])
    expect(config.headers).toBeUndefined()
  })

  it('展开出的数据源与页面手配的 REST 源同形', () => {
    const source = resolveApiBinding({ id: 'users', apiId: 'api-user-list' }, [
      makeApi({ description: '  分页列表  ', sample: [{ id: 1 }] }),
    ])

    // url 就是登记的路径本身：域名在发请求前才由 mergeRequestDefaults 拼上
    expect(source).toEqual({
      id: 'users',
      type: 'rest',
      description: '分页列表',
      sample: [{ id: 1 }],
      config: { kind: 'rest', url: '/users', method: 'GET' },
      autoFetch: true,
    })
  })

  it('接口不存在时不编造数据源，交给调用方提示悬空', () => {
    const source = resolveApiBinding({ id: 'users', apiId: 'gone' }, [])

    expect(source).toBeUndefined()
  })

  it('autoFetch 只在绑定显式写 false 时才关，空白说明不落键', () => {
    const apiTable = [makeApi({ description: '  ' })]

    expect(resolveApiBinding({ id: 'a', apiId: 'api-user-list' }, apiTable)?.autoFetch).toBe(
      true,
    )
    expect(
      resolveApiBinding({ id: 'a', apiId: 'api-user-list', autoFetch: false }, apiTable)
        ?.autoFetch,
    ).toBe(false)
    expect(
      Object.keys(resolveApiBinding({ id: 'a', apiId: 'api-user-list' }, apiTable)!),
    ).toEqual(['id', 'type', 'config', 'autoFetch'])
  })
})

describe('绑定展开与剥离', () => {
  const apiTable = [makeApi()]

  it('没有绑定或全部悬空时返回同一个引用', () => {
    const noBindings = makeSchema(
      [{ id: 'local', type: 'static', config: { kind: 'static', data: 1 } }],
      [],
    )
    const allDangling = makeSchema(undefined, [{ id: 'users', apiId: 'gone' }])

    expect(applyApiBindings(noBindings, apiTable)).toBe(noBindings)
    expect(applyApiBindings(allDangling, apiTable)).toBe(allDangling)
  })

  it('自有条目保持在前面，绑定条目追加在末尾', () => {
    const schema = makeSchema(
      [{ id: 'local', type: 'static', config: { kind: 'static', data: 1 } }],
      [{ id: 'users', apiId: 'api-user-list' }],
    )

    const loaded = applyApiBindings(schema, apiTable)

    expect(loaded.datasources?.map((item) => item.id)).toEqual(['local', 'users'])
    expect(loaded.datasources?.[1].config).toEqual({
      kind: 'rest',
      url: '/users',
      method: 'GET',
    })
  })

  it('同名的自有条目被绑定原位顶掉，位置不会跳到末尾', () => {
    const schema = makeSchema(
      [
        { id: 'users', type: 'static', config: { kind: 'static', data: 'stale' } },
        { id: 'local', type: 'static', config: { kind: 'static', data: 1 } },
      ],
      [{ id: 'users', apiId: 'api-user-list' }],
    )

    const loaded = applyApiBindings(schema, apiTable)

    expect(loaded.datasources?.map((item) => item.id)).toEqual(['users', 'local'])
    expect(loaded.datasources?.[0].type).toBe('rest')
  })

  it('写回时剥离绑定条目，展开出的 URL 不会落盘', () => {
    const schema = makeSchema(
      [{ id: 'local', type: 'static', config: { kind: 'static', data: 1 } }],
      [{ id: 'users', apiId: 'api-user-list' }],
    )

    const persisted = stripApiBindings(applyApiBindings(schema, apiTable))

    expect(persisted.datasources?.map((item) => item.id)).toEqual(['local'])
    expect(persisted.apis).toEqual([{ id: 'users', apiId: 'api-user-list' }])
  })

  it('剥离后一条自有数据源都不留时序列化不出 datasources 键', () => {
    const schema = makeSchema(undefined, [{ id: 'users', apiId: 'api-user-list' }])

    const persisted = stripApiBindings(applyApiBindings(schema, apiTable))

    expect(persisted.datasources).toBeUndefined()
    expect(JSON.stringify(persisted)).not.toContain('datasources')
  })

  it('没有绑定的文档剥离后返回同一个引用', () => {
    const schema = makeSchema(
      [{ id: 'local', type: 'static', config: { kind: 'static', data: 1 } }],
      undefined,
    )

    expect(stripApiBindings(schema)).toBe(schema)
  })
})

describe('引用体检', () => {
  it('列出指向不存在接口的绑定，顺序与声明一致', () => {
    const unresolved = findUnresolvedBindings(
      [
        { id: 'ok', apiId: 'api-user-list' },
        { id: 'bad1', apiId: 'gone' },
        { id: 'bad2', apiId: 'also-gone' },
      ],
      [makeApi()],
    )

    expect(unresolved.map((item) => item.id)).toEqual(['bad1', 'bad2'])
  })

  it('重名绑定单独报出来：它会在写回时带走一条自有数据源', () => {
    const conflicts = findBindingIdConflicts(
      makeSchema(
        [{ id: 'users', type: 'static', config: { kind: 'static', data: 1 } }],
        [{ id: 'users', apiId: 'api-user-list' }],
      ),
    )

    expect(conflicts).toEqual(['users'])
  })

  it('文档里没有自有数据源时不报重名', () => {
    const conflicts = findBindingIdConflicts(
      makeSchema(undefined, [{ id: 'users', apiId: 'api-user-list' }]),
    )

    expect(conflicts).toEqual([])
  })
})
