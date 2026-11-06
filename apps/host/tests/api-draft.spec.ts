import { describe, expect, it } from 'vitest'
import type { ProjectApi } from '@lc/schema'
import { normalizeApiInput } from '../src/apis/api-model'
import {
  createApiDraft,
  draftFromApi,
  mapToRows,
  parseApiDraft,
  rowsToMap,
} from '../src/components/api/api-draft'

/**
 * 接口草稿与提交值的往返。
 *
 * 这一层的错误表现是「保存一次定义，某个没碰过的字段变了」或「半截 JSON 被存进接口」，
 * 两者都要等请求发出去才暴露，所以必须在这里钉死。
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

describe('草稿初值', () => {
  it('新建时键值对先给一行空行，让人看得出这里能填', () => {
    const draft = createApiDraft()

    expect(draft.headers).toEqual([{ key: '', value: '' }])
    expect(draft.params).toEqual([{ key: '', value: '' }])
    expect(draft.method).toBe('GET')
    expect(draft.withCredentials).toBe(false)
  })

  it('缺省字段展开成表单初始值，而不是留下无法区分两种「没填」的空位', () => {
    const draft = draftFromApi(makeApi())

    expect(draft.group).toBe('')
    expect(draft.description).toBe('')
    expect(draft.bodyText).toBe('')
    expect(draft.sampleText).toBe('')
    expect(draft.withCredentials).toBe(false)
    expect(draft.responseType).toBe('json')
  })

  it('空映射与已有条目都走同一套行形状', () => {
    expect(mapToRows(undefined)).toEqual([{ key: '', value: '' }])
    expect(mapToRows({ 'X-A': '1' })).toEqual([{ key: 'X-A', value: '1' }])
  })
})

describe('键值行清洗', () => {
  it('丢空键、保留空值、全空给缺省', () => {
    expect(
      rowsToMap([
        { key: '  ', value: 'x' },
        { key: 'X-A', value: '' },
      ]),
    ).toEqual({
      'X-A': '',
    })
    expect(rowsToMap([{ key: '', value: '' }])).toBeUndefined()
  })
})

describe('草稿提交', () => {
  it('缺名称与缺路径分别给出可直接展示的文案', () => {
    const draft = createApiDraft()
    draft.path = '/users'
    expect(parseApiDraft(draft).error).toBe('接口必须命名')

    draft.name = '用户列表'
    draft.path = '  '
    expect(parseApiDraft(draft).error).toBe('接口必须填写请求路径')
  })

  it('请求体与样本的半截 JSON 连字段都不产出', () => {
    const draft = createApiDraft()
    draft.name = '用户列表'
    draft.path = '/users'

    draft.bodyText = '{ "name": '
    expect(parseApiDraft(draft).error).toMatch(/^请求体：JSON 解析失败/)
    expect(parseApiDraft(draft).input).toBeUndefined()

    draft.bodyText = ''
    draft.sampleText = 'not json'
    expect(parseApiDraft(draft).error).toMatch(/^响应样本：/)
  })

  it('结果类型由调用方传入，没有声明时不落键', () => {
    const draft = createApiDraft()
    draft.name = '用户列表'
    draft.path = '/users'

    expect(parseApiDraft(draft).input?.resultType).toBeUndefined()
    expect(parseApiDraft(draft, { kind: 'array' }).input?.resultType).toEqual({ kind: 'array' })
  })
})

describe('定义 → 草稿 → 提交 的往返', () => {
  it('一条完整定义编辑一轮之后字段不变', () => {
    const api = makeApi({
      group: '用户',
      description: '分页列表',
      method: 'POST',
      path: '/users/search',
      headers: { 'X-Trace': 'abc' },
      params: { page: '1' },
      body: { keyword: 'tom' },
      sample: [{ id: 1, name: 'Tom' }],
      resultType: {
        kind: 'array',
        item: { kind: 'object', fields: { id: { kind: 'number' } } },
      },
      withCredentials: true,
      responseType: 'text',
    })

    const parsed = parseApiDraft(draftFromApi(api), api.resultType)
    const roundTripped = normalizeApiInput(
      parsed.input ?? expect.unreachable('往返应当通过校验'),
    )

    expect(parsed.error).toBe('')
    expect(roundTripped).toEqual({
      name: '用户列表',
      group: '用户',
      description: '分页列表',
      method: 'POST',
      path: '/users/search',
      headers: { 'X-Trace': 'abc' },
      params: { page: '1' },
      body: { keyword: 'tom' },
      sample: [{ id: 1, name: 'Tom' }],
      resultType: api.resultType,
      withCredentials: true,
      responseType: 'text',
    })
  })

  it('没填的可选字段在往返后仍然缺席', () => {
    const parsed = parseApiDraft(draftFromApi(makeApi()), undefined)
    const roundTripped = normalizeApiInput(
      parsed.input ?? expect.unreachable('往返应当通过校验'),
    )

    expect(Object.keys(roundTripped).sort()).toEqual(['method', 'name', 'path'])
  })
})
