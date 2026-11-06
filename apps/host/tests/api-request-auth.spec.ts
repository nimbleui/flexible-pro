import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestDefaults } from '@lc/schema'
import { httpService, sendApiRequest } from '../src/apis/api-request'

/**
 * 凭据流程：取票、注入、401 重取一次并重发。
 *
 * 这几条边界决定了「token 过期」这件事是可用的还是灾难：重发没有上限会把登录接口打爆，
 * 缓存不清会让请求一直带着失效凭据，并发不去重会让一次页面加载发出 N 次登录。
 */

const LOGIN_PATH = '/auth/login'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function defaultsWithAuth(overrides: Partial<RequestDefaults> = {}): RequestDefaults {
  return {
    auth: {
      request: { method: 'POST', path: LOGIN_PATH },
      tokenPath: 'data.token',
    },
    ...overrides,
  }
}

/** 按路径分派的 fetch 替身；返回每次调用的 method + url + 请求头 */
function makeFetch(handlers: Record<string, () => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []

  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).split('?')[0] ?? ''
    calls.push({ url: String(url), init })
    const handler = handlers[path]
    if (!handler) return new Response('not found', { status: 404, statusText: 'Not Found' })

    return handler()
  })

  return { fetchMock: fetchMock as unknown as typeof fetch, calls }
}

beforeEach(() => {
  httpService.dropTokens()
})

describe('取票与注入', () => {
  it('业务请求带上注入的凭据头，登录请求不带', async () => {
    const { fetchMock, calls } = makeFetch({
      [LOGIN_PATH]: () => jsonResponse({ data: { token: 'T1' } }),
      '/users': () => jsonResponse([{ id: 1 }]),
    })

    const result = await sendApiRequest({ method: 'GET', path: '/users' }, defaultsWithAuth(), {
      fetchImpl: fetchMock,
    })

    expect(result.ok).toBe(true)
    expect(calls.map((call) => call.url)).toEqual([LOGIN_PATH, '/users'])
    expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe('Bearer T1')
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBeNull()
  })

  it('第二次请求复用缓存凭据，不再登录', async () => {
    const { fetchMock, calls } = makeFetch({
      [LOGIN_PATH]: () => jsonResponse({ data: { token: 'T1' } }),
      '/users': () => jsonResponse([]),
    })

    await sendApiRequest({ method: 'GET', path: '/users' }, defaultsWithAuth(), {
      fetchImpl: fetchMock,
    })
    await sendApiRequest({ method: 'GET', path: '/orders' }, defaultsWithAuth(), {
      fetchImpl: fetchMock,
    })

    expect(calls.filter((call) => call.url === LOGIN_PATH)).toHaveLength(1)
  })

  it('并发只登录一次', async () => {
    const { fetchMock, calls } = makeFetch({
      [LOGIN_PATH]: () => jsonResponse({ data: { token: 'T1' } }),
      '/users': () => jsonResponse([]),
      '/orders': () => jsonResponse([]),
    })

    await Promise.all([
      sendApiRequest({ method: 'GET', path: '/users' }, defaultsWithAuth(), {
        fetchImpl: fetchMock,
      }),
      sendApiRequest({ method: 'GET', path: '/orders' }, defaultsWithAuth(), {
        fetchImpl: fetchMock,
      }),
    ])

    expect(calls.filter((call) => call.url === LOGIN_PATH)).toHaveLength(1)
  })

  it('dropTokens 之后会重新登录', async () => {
    const { fetchMock, calls } = makeFetch({
      [LOGIN_PATH]: () => jsonResponse({ data: { token: 'T1' } }),
      '/users': () => jsonResponse([]),
    })

    await sendApiRequest({ method: 'GET', path: '/users' }, defaultsWithAuth(), {
      fetchImpl: fetchMock,
    })
    httpService.dropTokens()
    await sendApiRequest({ method: 'GET', path: '/users' }, defaultsWithAuth(), {
      fetchImpl: fetchMock,
    })

    expect(calls.filter((call) => call.url === LOGIN_PATH)).toHaveLength(2)
  })

  it('响应里没有该路径时明确报出来，而不是发一个空 token', async () => {
    const { fetchMock } = makeFetch({
      [LOGIN_PATH]: () => jsonResponse({ data: { other: 1 } }),
      '/users': () => jsonResponse([]),
    })

    const result = await sendApiRequest({ method: 'GET', path: '/users' }, defaultsWithAuth(), {
      fetchImpl: fetchMock,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('data.token 不是可用的字符串凭据')
  })

  it('登录接口本身失败时把原因带出来', async () => {
    const { fetchMock } = makeFetch({
      [LOGIN_PATH]: () => new Response('gone', { status: 500, statusText: 'Server Error' }),
    })

    const result = await sendApiRequest({ method: 'GET', path: '/users' }, defaultsWithAuth(), {
      fetchImpl: fetchMock,
    })

    expect(result.error).toContain('登录接口取凭据失败')
    expect(result.error).toContain('HTTP 500')
  })
})

describe('401 重取一次', () => {
  it('第一次 401 会换新凭据重发，并只重发一次', async () => {
    const tokens = ['OLD', 'NEW']
    const { fetchMock, calls } = makeFetch({
      [LOGIN_PATH]: () => jsonResponse({ data: { token: tokens.shift() ?? 'NEW' } }),
      '/users': () =>
        calls.filter((call) => call.url === '/users').length === 1
          ? new Response('stale', { status: 401, statusText: 'Unauthorized' })
          : jsonResponse([{ id: 1 }]),
    })

    const result = await sendApiRequest({ method: 'GET', path: '/users' }, defaultsWithAuth(), {
      fetchImpl: fetchMock,
    })

    expect(result.ok).toBe(true)
    expect(calls.filter((call) => call.url === LOGIN_PATH)).toHaveLength(2)
    expect(new Headers(calls[calls.length - 1]?.init?.headers).get('authorization')).toBe(
      'Bearer NEW',
    )
  })

  it('换了新凭据仍然 401 就如实失败，不再打转', async () => {
    const { fetchMock, calls } = makeFetch({
      [LOGIN_PATH]: () => jsonResponse({ data: { token: 'T' } }),
      '/users': () => new Response('no', { status: 401, statusText: 'Unauthorized' }),
    })

    const result = await sendApiRequest({ method: 'GET', path: '/users' }, defaultsWithAuth(), {
      fetchImpl: fetchMock,
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(calls.filter((call) => call.url === '/users')).toHaveLength(2)
  })

  it('没配凭据时 401 就是一次普通失败', async () => {
    const { fetchMock, calls } = makeFetch({
      '/users': () => new Response('no', { status: 401, statusText: 'Unauthorized' }),
    })

    const result = await sendApiRequest({ method: 'GET', path: '/users' }, undefined, {
      fetchImpl: fetchMock,
    })

    expect(result.status).toBe(401)
    expect(calls).toHaveLength(1)
  })
})
