import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENVIRONMENT,
  activeEnvironment,
  isEnvironment,
  isUsableBaseUrl,
  narrowScopeConfig,
  normalizeEnvironment,
  toRequestDefaults,
} from '../src/apis/api-config-model'

/**
 * 请求环境（域名、默认头、默认参数）的归一化与读档收窄。
 *
 * 这些判断决定「保存下来的配置」和「下次装载读回来的配置」是不是同一件事。域名写错的后果
 * 尤其难查：`api.test/svc` 会被浏览器当相对路径打到前端自己身上并返回 200 的 HTML，
 * 看上去像接口挂了。
 */

describe('环境归一化', () => {
  it('裁掉首尾空白，空白字段与空集合都不落键', () => {
    const env = normalizeEnvironment({
      id: 'env-1',
      name: '  测试  ',
      baseUrl: '  https://api.test  ',
      headers: {},
      params: {},
      withCredentials: false,
    })

    expect(env).toEqual({ id: 'env-1', name: '测试', baseUrl: 'https://api.test' })
  })

  it('缺 id 时自动生成，保证新建与修改走同一个函数', () => {
    const env = normalizeEnvironment({ name: '本地' })

    expect(env.id).not.toBe('')
    expect(env.name).toBe('本地')
  })

  it('名称为空即拒绝；域名缺协议又缺斜杠也拒绝', () => {
    expect(() => normalizeEnvironment({ name: '   ' })).toThrow('环境必须命名')
    expect(() => normalizeEnvironment({ name: '测试', baseUrl: 'api.test/svc' })).toThrow(
      '域名需要是绝对地址',
    )
  })

  it('以 / 开头的路径前缀与绝对地址同样合法，留空表示同源', () => {
    expect(isUsableBaseUrl('/api')).toBe(true)
    expect(isUsableBaseUrl('//cdn.test')).toBe(true)
    expect(isUsableBaseUrl('  ')).toBe(true)
    expect(isUsableBaseUrl('api.test')).toBe(false)
  })
})

describe('环境 → 请求默认值', () => {
  it('只取请求侧字段：id 与名称不参与请求', () => {
    const defaults = toRequestDefaults({
      id: 'env-1',
      name: '测试',
      baseUrl: 'https://api.test',
      headers: { Authorization: 'Bearer t' },
    })

    expect(defaults).toEqual({
      baseUrl: 'https://api.test',
      headers: { Authorization: 'Bearer t' },
    })
    expect(toRequestDefaults(undefined)).toBeUndefined()
  })

  it('凭据来源随环境一起带出去，否则取数侧永远看不到 token 配置', () => {
    const auth = {
      request: { method: 'POST' as const, path: '/login' },
      tokenPath: 'data.token',
    }

    expect(toRequestDefaults({ id: 'e', name: '测试', auth })?.auth).toEqual(auth)
  })
})

describe('凭据来源', () => {
  it('裁掉路径空白、保留来源 id，缺 token 路径直接拒绝', () => {
    const env = normalizeEnvironment({
      id: 'e',
      name: '测试',
      auth: {
        request: { method: 'POST', path: '  /auth/login  ' },
        sourceApiId: 'api-login',
        tokenPath: '  data.token ',
        headerName: '  ',
        valueTemplate: '  ',
      },
    })

    expect(env.auth).toEqual({
      request: { method: 'POST', path: '/auth/login' },
      sourceApiId: 'api-login',
      tokenPath: 'data.token',
    })
    expect(() =>
      normalizeEnvironment({
        name: '测试',
        auth: { request: { method: 'GET', path: '/login' }, tokenPath: '  ' },
      }),
    ).toThrow('token 在响应里的路径')
  })

  it('凭据形状写坏时整条环境一起丢：宁可不带 token 报 401，也不拿半个配置发请求', () => {
    const badAuth: unknown[] = [
      { id: 'a', name: 'x', auth: { tokenPath: 'data.token' } },
      { id: 'a', name: 'x', auth: { request: { method: 'GET', path: '' }, tokenPath: 't' } },
      {
        id: 'a',
        name: 'x',
        auth: { request: { method: 'GET', path: '/login' }, tokenPath: '' },
      },
      { id: 'a', name: 'x', auth: 'login-api' },
    ]

    for (const value of badAuth) expect(isEnvironment(value)).toBe(false)
  })
})

describe('生效环境取值', () => {
  it('没有配过环境时给兜底那套，而不是 undefined', () => {
    expect(activeEnvironment(undefined)).toBe(DEFAULT_ENVIRONMENT)
    expect(activeEnvironment({ environments: [], activeEnvId: 'x' })).toBe(DEFAULT_ENVIRONMENT)
  })

  it('指针指向已删除的环境时落到第一项', () => {
    const first = { id: 'a', name: '本地' }
    const second = { id: 'b', name: '测试' }

    expect(activeEnvironment({ environments: [first, second], activeEnvId: 'gone' })).toBe(
      first,
    )
    expect(activeEnvironment({ environments: [first, second], activeEnvId: 'b' })).toBe(second)
  })
})

describe('读档收窄', () => {
  it('坏形状的环境被丢弃，其余仍然可用', () => {
    const config = narrowScopeConfig({
      environments: [
        { id: 'a', name: '本地' },
        { id: 'b', name: '坏', baseUrl: 'api.test' },
        { id: '', name: '缺 id' },
        null,
      ],
      activeEnvId: 'a',
    })

    expect(config?.environments.map((env) => env.id)).toEqual(['a'])
    expect(config?.activeEnvId).toBe('a')
  })

  it('同 id 的两条环境只留第一条：指针会指向哪一条不该看遍历顺序', () => {
    const config = narrowScopeConfig({
      environments: [
        { id: 'a', name: '第一条', baseUrl: '/one' },
        { id: 'a', name: '第二条', baseUrl: '/two' },
      ],
      activeEnvId: 'a',
    })

    expect(config?.environments).toHaveLength(1)
    expect(config?.environments[0]?.name).toBe('第一条')
  })

  it('全部坏掉或缺 environments 时按「没有配置」处理', () => {
    expect(narrowScopeConfig({ environments: [{ id: 'a' }], activeEnvId: 'a' })).toBeUndefined()
    expect(narrowScopeConfig({ activeEnvId: 'a' })).toBeUndefined()
    expect(narrowScopeConfig('scope')).toBeUndefined()
  })

  it('指针指向已被丢弃的环境时自动校正', () => {
    const config = narrowScopeConfig({
      environments: [{ id: 'a', name: '本地' }],
      activeEnvId: 'deleted-env',
    })

    expect(config?.activeEnvId).toBe('a')
  })

  it('可选字段类型写坏即整条环境拒收，不让它进面板再崩渲染', () => {
    const badRecords: unknown[] = [
      { id: 'a', name: 'x', withCredentials: 'yes' },
      { id: 'a', name: 'x', headers: { A: 1 } },
      { id: 'a', name: 'x', params: null },
      { id: 'a', name: '' },
      { id: 'a', name: 'x', autoRetry: 'yes' },
      { id: 'a', name: 'x', requestLogging: 1 },
      { id: 'a', name: 'x', responseHeaders: { A: 1 } },
    ]

    for (const value of badRecords) expect(isEnvironment(value)).toBe(false)
  })
})

describe('响应头登记与重试 / 日志开关', () => {
  it('autoRetry 缺省 true 只落 false，requestLogging 缺省 false 只落 true', () => {
    const env = normalizeEnvironment({
      id: 'e',
      name: '测试',
      autoRetry: true,
      requestLogging: false,
    })
    expect(env.autoRetry).toBeUndefined()
    expect(env.requestLogging).toBeUndefined()

    const flipped = normalizeEnvironment({
      id: 'e',
      name: '测试',
      autoRetry: false,
      requestLogging: true,
    })
    expect(flipped.autoRetry).toBe(false)
    expect(flipped.requestLogging).toBe(true)
  })

  it('响应头登记按默认头同一规则清洗，空集合不落键', () => {
    const env = normalizeEnvironment({
      id: 'e',
      name: '测试',
      responseHeaders: { '  ': 'x', 'Access-Control-Allow-Origin': ' * ' },
    })
    expect(env.responseHeaders).toEqual({ 'Access-Control-Allow-Origin': '*' })

    expect(
      normalizeEnvironment({ id: 'e', name: '测试', responseHeaders: {} }).responseHeaders,
    ).toBeUndefined()
  })

  it('重试 / 日志开关随请求默认值带出去，响应头登记不属于请求侧', () => {
    const defaults = toRequestDefaults({
      id: 'e',
      name: '测试',
      autoRetry: false,
      requestLogging: true,
      responseHeaders: { 'Access-Control-Allow-Origin': '*' },
    })

    expect(defaults).toEqual({ autoRetry: false, requestLogging: true })
    expect(defaults && 'responseHeaders' in defaults).toBe(false)
  })
})
