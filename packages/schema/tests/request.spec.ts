import { describe, expect, it } from 'vitest'
import type { RequestDefaults, RestConfig } from '../src/index'
import { mergeRequestDefaults, withAuthHeader } from '../src/index'

/**
 * 全局请求默认值与单条请求配置的合并。
 *
 * 这份规则同时被运行时取数与接口调试台使用，所以它的每条边界都对应一句可被用户验证的话：
 * 「页面里没填 Authorization 也能带上项目配置的 token」「填了空值不会被偷偷回填」
 * 「切了域名下一次取数就是新地址」。合并结果还要保证字段顺序稳定，取数服务拿它的 JSON
 * 字符串当配置指纹。
 */

describe('域名拼接', () => {
  it('相对地址按默认前缀拼接，绝对地址原样通过', () => {
    const defaults = { baseUrl: 'https://api.test/svc' }

    expect(mergeRequestDefaults({ kind: 'rest', url: '/users' }, defaults).url).toBe(
      'https://api.test/svc/users',
    )
    expect(
      mergeRequestDefaults({ kind: 'rest', url: 'https://other.test/x' }, defaults).url,
    ).toBe('https://other.test/x')
  })

  it('没有默认前缀时不碰地址', () => {
    expect(mergeRequestDefaults({ kind: 'rest', url: '/users' }, undefined).url).toBe('/users')
    expect(mergeRequestDefaults({ kind: 'rest', url: '/users' }, { baseUrl: '  ' }).url).toBe(
      '/users',
    )
  })
})

describe('请求头与查询参数合并', () => {
  it('请求没写过的键才补默认值', () => {
    const merged = mergeRequestDefaults(
      { kind: 'rest', url: '/u', headers: { 'X-Trace': 'local' } },
      { headers: { 'X-Trace': 'global', Authorization: 'Bearer t' } },
    )

    expect(merged.headers).toEqual({ 'X-Trace': 'local', Authorization: 'Bearer t' })
  })

  it('请求头名大小写不敏感，查询参数大小写敏感', () => {
    const headers = mergeRequestDefaults(
      { kind: 'rest', url: '/u', headers: { authorization: 'Bearer local' } },
      { headers: { Authorization: 'Bearer global' } },
    ).headers
    expect(headers).toEqual({ authorization: 'Bearer local' })

    const params = mergeRequestDefaults(
      { kind: 'rest', url: '/u', params: { Page: '2' } },
      { params: { page: '1' } },
    ).params
    expect(params).toEqual({ Page: '2', page: '1' })
  })

  it('请求显式写了空值就不回填：界面上清空一个头不该被配置塞回来', () => {
    const merged = mergeRequestDefaults(
      { kind: 'rest', url: '/u', headers: { 'X-Debug': '' } },
      { headers: { 'X-Debug': 'on' } },
    )

    expect(merged.headers).toEqual({ 'X-Debug': '' })
  })

  it('空键丢弃，两边都没有效条目时不落空对象键', () => {
    const merged = mergeRequestDefaults(
      { kind: 'rest', url: '/u', headers: { '  ': 'x' } },
      { headers: { '': 'y' } },
    )

    expect('headers' in merged).toBe(false)
  })
})

describe('凭据与方法', () => {
  it('请求显式 false 的凭据优先于默认的 true', () => {
    const defaults: RequestDefaults = { withCredentials: true }

    expect(
      mergeRequestDefaults({ kind: 'rest', url: '/u', withCredentials: false }, defaults)
        .withCredentials,
    ).toBe(false)
    expect(mergeRequestDefaults({ kind: 'rest', url: '/u' }, defaults).withCredentials).toBe(
      true,
    )
  })

  it('缺省方法补 GET，responseType 原样带过', () => {
    const merged = mergeRequestDefaults(
      { kind: 'rest', url: '/u', responseType: 'text' },
      undefined,
    )

    expect(merged.method).toBe('GET')
    expect(merged.responseType).toBe('text')
  })
})

describe('注入凭据头', () => {
  const auth = { request: { method: 'POST' as const, path: '/login' }, tokenPath: 'data.token' }

  it('默认头名与模板是 Authorization / Bearer {token}', () => {
    const merged = mergeRequestDefaults({ kind: 'rest', url: '/users' }, undefined)

    expect(withAuthHeader(merged, auth, 'abc').headers).toEqual({ Authorization: 'Bearer abc' })
  })

  it('自定义头名与模板；模板里没有占位符就原样用它', () => {
    const merged = withAuthHeader(
      { kind: 'rest', url: '/u' },
      { ...auth, headerName: 'X-Token', valueTemplate: 'Token={token}' },
      'abc',
    )
    expect(merged.headers).toEqual({ 'X-Token': 'Token=abc' })

    const literal = withAuthHeader(
      { kind: 'rest', url: '/u' },
      { ...auth, valueTemplate: 'fixed' },
      'abc',
    )
    expect(literal.headers).toEqual({ Authorization: 'fixed' })
  })

  it('请求或默认头已经有同名头（忽略大小写）就不覆盖', () => {
    const config: RestConfig = {
      kind: 'rest',
      url: '/u',
      headers: { authorization: 'Bearer mine' },
    }

    expect(withAuthHeader(config, auth, 'abc')).toBe(config)
  })

  it('空凭据原样返回：发一个不带该头的请求，比发 `Bearer ` 这种半成品好诊断', () => {
    const config: RestConfig = { kind: 'rest', url: '/u' }

    expect(withAuthHeader(config, auth, '   ')).toBe(config)
  })

  it('不修改入参的 headers', () => {
    const config: RestConfig = { kind: 'rest', url: '/u', headers: { 'X-A': '1' } }

    const next = withAuthHeader(config, auth, 'abc')

    expect(config.headers).toEqual({ 'X-A': '1' })
    expect(next.headers).toEqual({ 'X-A': '1', Authorization: 'Bearer abc' })
  })
})

describe('合并输出的稳定性', () => {
  it('同一输入两次合并得到完全相同的字符串（取数服务靠它做配置指纹）', () => {
    const config: RestConfig = {
      kind: 'rest',
      url: '/users',
      headers: { 'X-B': '2', 'X-A': '1' },
      body: { q: 1 },
    }
    const defaults = { baseUrl: '/svc', params: { page: '1' }, withCredentials: true }

    expect(JSON.stringify(mergeRequestDefaults(config, defaults))).toBe(
      JSON.stringify(mergeRequestDefaults(config, defaults)),
    )
  })

  it('字段顺序固定，与入参里键的书写顺序无关', () => {
    const reordered: RestConfig = {
      body: { q: 1 },
      url: '/users',
      method: 'POST',
      kind: 'rest',
    }
    const declared: RestConfig = { kind: 'rest', url: '/users', method: 'POST', body: { q: 1 } }

    expect(Object.keys(mergeRequestDefaults(reordered, undefined))).toEqual([
      'kind',
      'url',
      'method',
      'body',
    ])
    expect(JSON.stringify(mergeRequestDefaults(reordered, undefined))).toBe(
      JSON.stringify(mergeRequestDefaults(declared, undefined)),
    )
  })

  it('不修改入参：合并产物是新对象', () => {
    const config: RestConfig = { kind: 'rest', url: '/users', headers: { 'X-A': '1' } }

    const merged = mergeRequestDefaults(config, { headers: { 'X-B': '2' } })

    expect(config.headers).toEqual({ 'X-A': '1' })
    expect(merged.headers).not.toBe(config.headers)
    expect(merged).not.toBe(config)
  })
})
