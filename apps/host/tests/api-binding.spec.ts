import { describe, expect, it } from 'vitest'
import type { DataSourceSchemaDef, PageApiBinding, PageSchema, ProjectApi } from '@lc/schema'
import { SCHEMA_VERSION, applyPatches } from '@lc/schema'
import {
  bindingPatches,
  suggestBindingName,
} from '../src/components/page-data/utils/api-binding'

/**
 * 引用项目接口的两条纯逻辑：默认绑定名、以及一次改动要打的补丁。
 *
 * 补丁这条最值得钉：只改 `apis` 的话画布要重新装载才看见新数据项，只改 `datasources`
 * 的话写回存储时会被剥离掉——两种漏法都表现为「明明点了引用却没生效」。
 */

function makeApi(overrides: Partial<ProjectApi> = {}): ProjectApi {
  return {
    id: 'api-1',
    projectId: 'project-1',
    name: '用户列表',
    method: 'GET',
    path: '/users',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeSchema(datasources?: DataSourceSchemaDef[], apis?: PageApiBinding[]): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'root',
    nodes: {},
    components: [],
    ...(datasources === undefined ? {} : { datasources }),
    ...(apis === undefined ? {} : { apis }),
  }
}

const localStatic: DataSourceSchemaDef = {
  id: 'conf',
  type: 'static',
  config: { kind: 'static', data: { theme: 'dark' } },
}

/** 项目侧的接口表；路径保持登记原样，域名在发请求时才拼 */
const apiTable = [makeApi(), makeApi({ id: 'api-2', path: '/orders/{id}' })]

describe('默认绑定名', () => {
  it('取路径最后一个真实段，占位段不参与', () => {
    expect(suggestBindingName(makeApi({ path: '/orders/{id}' }), new Set())).toBe('orders')
    expect(suggestBindingName(makeApi({ path: ':id/orders' }), new Set())).toBe('orders')
  })

  it('连字符与下划线拼成驼峰', () => {
    expect(suggestBindingName(makeApi({ path: '/api/order-items' }), new Set())).toBe(
      'orderItems',
    )
    expect(suggestBindingName(makeApi({ path: '/api/order_items' }), new Set())).toBe(
      'orderItems',
    )
  })

  it('名字被占用时追加序号，而不是造出第二个同名数据项', () => {
    expect(suggestBindingName(makeApi(), new Set(['users']))).toBe('users2')
    expect(suggestBindingName(makeApi(), new Set(['users', 'users2']))).toBe('users3')
  })

  it('路径推不出合法标识符时退回 id 的最后一段，再不成才用兜底名', () => {
    expect(
      suggestBindingName(makeApi({ path: 'https://api.test/users?page=2' }), new Set()),
    ).toBe('users')
    expect(suggestBindingName(makeApi({ path: '/', id: 'api-42' }), new Set())).toBe('api42')
    expect(suggestBindingName(makeApi({ path: '/2024', id: '7' }), new Set())).toBe('apiData')
  })
})

describe('绑定补丁', () => {
  it('首次引用同时补上 apis 与展开后的数据源', () => {
    const schema = makeSchema([localStatic])
    const next: PageApiBinding[] = [{ id: 'users', apiId: 'api-1' }]
    const patches = bindingPatches(schema, next, apiTable)

    expect(patches.map((patch) => patch.path)).toEqual(['/apis', '/datasources'])
    expect(patches[0]?.op).toBe('add')

    const result = applyPatches(schema, patches)
    expect(result.apis).toEqual(next)
    expect(result.datasources?.map((item) => item.id)).toEqual(['conf', 'users'])
    expect(result.datasources?.[1]?.config).toEqual({
      kind: 'rest',
      url: '/users',
      method: 'GET',
    })
  })

  it('解绑把展开出的那条一起带走，页面自有条目原样留下', () => {
    const bound = makeSchema(
      [localStatic, { id: 'users', type: 'rest', config: { kind: 'rest', url: '/users' } }],
      [{ id: 'users', apiId: 'api-1' }],
    )

    const result = applyPatches(bound, bindingPatches(bound, [], apiTable))

    expect(result.apis).toBeUndefined()
    expect(result.datasources?.map((item) => item.id)).toEqual(['conf'])
  })

  it('换绑到另一个接口时不会留下前一个接口的条目', () => {
    const bound = makeSchema(
      [localStatic, { id: 'users', type: 'rest', config: { kind: 'rest', url: '/users' } }],
      [{ id: 'users', apiId: 'api-1' }],
    )

    const next: PageApiBinding[] = [{ id: 'users', apiId: 'api-2' }]
    const result = applyPatches(bound, bindingPatches(bound, next, apiTable))

    expect(result.datasources?.map((item) => item.id)).toEqual(['conf', 'users'])
    expect(result.datasources?.[1]?.config).toEqual({
      kind: 'rest',
      url: '/orders/{id}',
      method: 'GET',
    })
  })

  it('接口已不存在时不编造条目，但绑定关系仍然保留（由列表标成引用失效）', () => {
    const schema = makeSchema([localStatic])
    const next: PageApiBinding[] = [{ id: 'ghost', apiId: 'gone' }]

    const result = applyPatches(schema, bindingPatches(schema, next, apiTable))

    expect(result.apis).toEqual(next)
    expect(result.datasources?.map((item) => item.id)).toEqual(['conf'])
  })

  it('绑定名为空列表时属性被删掉，不留空数组', () => {
    const bound = makeSchema([localStatic], [{ id: 'users', apiId: 'api-1' }])

    const patches = bindingPatches(bound, [], apiTable)

    expect(patches[0]).toEqual({ op: 'remove', path: '/apis' })
  })
})
