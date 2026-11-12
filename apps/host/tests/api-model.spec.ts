import { describe, expect, it } from 'vitest'
import type { ProjectApi } from '@lc/schema'
import type { ApiInput } from '../src/apis/api-model'
import {
  API_METHOD_OPTIONS,
  groupApis,
  isProjectApi,
  moveApiBefore,
  normalizeApiInput,
  sanitizeEntries,
  sanitizeParamMeta,
  sanitizeTags,
} from '../src/apis/api-model'

/**
 * 接口登记的输入归一化与读档收窄。
 *
 * 这两件事直接决定「存进去的接口长什么样」和「坏数据会不会进列表」：空白字段落成 `''`
 * 会让 diff 每次都判成有改动，非法方法放进来了拼接与请求才会半路炸掉。
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

function makeInput(overrides: Partial<ApiInput> = {}): ApiInput {
  return { name: '用户列表', method: 'GET', path: '/users', ...overrides }
}

describe('接口输入归一化', () => {
  it('裁掉首尾空白，空白串与空集合都不落键', () => {
    const editable = normalizeApiInput(
      makeInput({
        name: '  用户列表  ',
        path: '  /users  ',
        group: '   ',
        description: '',
        headers: {},
        params: {},
      }),
    )

    expect(editable.name).toBe('用户列表')
    expect(editable.path).toBe('/users')
    expect(Object.keys(editable)).toEqual(['name', 'method', 'path'])
  })

  it('false 的凭据与默认的 json 响应格式按缺省处理', () => {
    const editable = normalizeApiInput(
      makeInput({ withCredentials: false, responseType: 'json', body: null, sample: null }),
    )

    expect(editable.withCredentials).toBeUndefined()
    expect(editable.responseType).toBeUndefined()
    // null 是用户真填了的值，与「没填」不是一回事
    expect(editable.body).toBeNull()
    expect(editable.sample).toBeNull()
  })

  it('方法不在候选集合内即抛错：下拉与类型定义漂移要在保存时就炸出来', () => {
    expect(() =>
      normalizeApiInput(makeInput({ method: 'OPTIONS' as ApiInput['method'] })),
    ).toThrow('不支持的请求方法')
  })

  it('候选集合与 ApiMethod 全集一致，编辑器不会漏掉某个方法', () => {
    expect(API_METHOD_OPTIONS.map((item) => item.value)).toEqual([
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
    ])
  })
})

describe('键值对字段清洗', () => {
  it('丢掉空键但保留空值：清空一个头是有意义的', () => {
    const map = sanitizeEntries({ '  ': 'x', 'X-A': '  ', 'X-B': '1' })

    expect(map).toEqual({ 'X-A': '', 'X-B': '1' })
  })

  it('全空即返回缺省，存储里不留 `{}`', () => {
    expect(sanitizeEntries(undefined)).toBeUndefined()
    expect(sanitizeEntries({ '': '' })).toBeUndefined()
  })
})

describe('接口读档收窄', () => {
  it('最小合法记录通过', () => {
    expect(isProjectApi(makeApi())).toBe(true)
  })

  it('缺名字、缺路径、缺方法、非法方法一律拒收', () => {
    expect(isProjectApi(makeApi({ name: '' }))).toBe(false)
    expect(isProjectApi({ ...makeApi(), path: '' })).toBe(false)
    expect(isProjectApi({ ...makeApi(), method: 'UNKNOWN' })).toBe(false)
    expect(isProjectApi({ ...makeApi(), method: undefined })).toBe(false)
  })

  it('键值对字段混进非字符串值即整条拒收', () => {
    // 存储里的坏形状是用户手改出来的，不是本模块能构造的值，所以按 unknown 传进去
    const badHeaders: unknown = { ...makeApi(), headers: { A: 1 } }
    const badParams: unknown = { ...makeApi(), params: { A: null } }

    expect(isProjectApi(badHeaders)).toBe(false)
    expect(isProjectApi(badParams)).toBe(false)
  })

  it('可选字段类型写坏也拒收，不让它进列表再崩渲染', () => {
    const badRecords: unknown[] = [
      { ...makeApi(), group: 3 },
      { ...makeApi(), withCredentials: 'yes' },
      { ...makeApi(), responseType: 'xml' },
      { ...makeApi(), projectId: 7 },
      null,
      'api',
    ]

    for (const value of badRecords) expect(isProjectApi(value)).toBe(false)
  })
})

describe('接口列表分组', () => {
  it('分组按首次出现的顺序排，未分组恒在最后', () => {
    const groups = groupApis([
      makeApi({ id: 'a', group: '订单' }),
      makeApi({ id: 'b', group: '用户' }),
      makeApi({ id: 'c' }),
      makeApi({ id: 'd', group: '订单' }),
    ])

    expect(groups.map((group) => group.name)).toEqual(['订单', '用户', null])
    expect(groups[0]?.apis.map((item) => item.id)).toEqual(['a', 'd'])
  })

  it('组内按修改时间倒序，最近改过的排在前面', () => {
    const groups = groupApis([
      makeApi({ id: 'old', group: '用户', updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeApi({ id: 'new', group: '用户', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ])

    expect(groups[0]?.apis.map((item) => item.id)).toEqual(['new', 'old'])
  })

  it('空白分组名与未分组归为同一组', () => {
    const groups = groupApis([makeApi({ id: 'a', group: '  ' }), makeApi({ id: 'b' })])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBeNull()
    expect(groups[0]?.apis).toHaveLength(2)
  })
})

describe('标签与参数登记清洗', () => {
  it('标签裁空白、丢空串、按首次出现去重，全空给缺省', () => {
    expect(sanitizeTags([' 用户 ', '信息', '用户', '  '])).toEqual(['用户', '信息'])
    expect(sanitizeTags(['  '])).toBeUndefined()
    expect(sanitizeTags(undefined)).toBeUndefined()
  })

  it('参数登记只保留 params 里存在的键，整条缺省的条目被丢掉', () => {
    const meta = sanitizeParamMeta(
      {
        page: { type: 'number', description: ' 页码 ' },
        gone: { required: true },
        plain: { type: 'string', required: false, description: '  ' },
      },
      { page: '1', plain: '' },
    )

    expect(meta).toEqual({ page: { type: 'number', description: '页码' } })
    expect(sanitizeParamMeta({ a: { required: true } }, undefined)).toBeUndefined()
  })

  it('归一化把标签 / 公开标记 / 参数登记一起带上，缺省不落键', () => {
    const editable = normalizeApiInput(
      makeInput({
        tags: ['用户', '用户'],
        isPublic: true,
        params: { userId: '' },
        paramMeta: { userId: { required: true, description: '用户ID' } },
      }),
    )

    expect(editable.tags).toEqual(['用户'])
    expect(editable.isPublic).toBe(true)
    expect(editable.paramMeta).toEqual({ userId: { required: true, description: '用户ID' } })

    const bare = normalizeApiInput(makeInput({ isPublic: false, tags: [] }))
    expect(bare.isPublic).toBeUndefined()
    expect(bare.tags).toBeUndefined()
  })
})

describe('拖拽重排', () => {
  it('把被拖项插到目标项前面，其余记录只平移不重排', () => {
    const apis = [makeApi({ id: 'a' }), makeApi({ id: 'b' }), makeApi({ id: 'c' })]

    expect(moveApiBefore(apis, 'c', 'a').map((item) => item.id)).toEqual(['c', 'a', 'b'])
    expect(moveApiBefore(apis, 'a', 'c').map((item) => item.id)).toEqual(['b', 'a', 'c'])
  })

  it('拖到自身或任一项不存在时原样返回同一引用，调用方据此跳过写库', () => {
    const apis = [makeApi({ id: 'a' }), makeApi({ id: 'b' })]

    expect(moveApiBefore(apis, 'a', 'a')).toBe(apis)
    expect(moveApiBefore(apis, 'gone', 'a')).toBe(apis)
    expect(moveApiBefore(apis, 'a', 'gone')).toBe(apis)
  })
})

describe('新增可选字段的读档收窄', () => {
  it('合法的标签 / 公开标记 / 参数登记通过', () => {
    expect(
      isProjectApi(
        makeApi({ tags: ['用户'], isPublic: true, paramMeta: { id: { type: 'number' } } }),
      ),
    ).toBe(true)
  })

  it('写坏的标签 / 公开标记 / 参数登记整条拒收', () => {
    const badRecords: unknown[] = [
      { ...makeApi(), tags: '用户' },
      { ...makeApi(), tags: [1] },
      { ...makeApi(), isPublic: 'yes' },
      { ...makeApi(), paramMeta: { id: { type: 'date' } } },
      { ...makeApi(), paramMeta: { id: { required: 'yes' } } },
      { ...makeApi(), paramMeta: 'x' },
    ]

    for (const value of badRecords) expect(isProjectApi(value)).toBe(false)
  })
})
