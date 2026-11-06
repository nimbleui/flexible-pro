import { describe, expect, it, vi } from 'vitest'
import { buildRestUrl, fetchRest } from '../src/rest'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('REST 取数', () => {
  it('拼接查询参数，保留已有查询串', () => {
    expect(
      buildRestUrl({
        kind: 'rest',
        url: '/api/users',
        params: { page: '1', q: 'a b' },
      }),
    ).toBe('/api/users?page=1&q=a+b')

    expect(buildRestUrl({ kind: 'rest', url: '/api/users?x=1', params: { page: '2' } })).toBe(
      '/api/users?x=1&page=2',
    )
  })

  it('POST 发送 JSON 并自动补 Content-Type', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true }),
    )
    await fetchRest(
      { kind: 'rest', url: '/api/users', method: 'POST', body: { name: 'Alice' } },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    )

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{"name":"Alice"}')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
  })

  it('GET 不发送 body，withCredentials 映射到 credentials', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(null),
    )
    await fetchRest(
      {
        kind: 'rest',
        url: '/api/users',
        body: { ignored: true },
        withCredentials: true,
      },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    )

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(init?.body).toBeUndefined()
    expect(init?.credentials).toBe('include')
  })

  it('非 2xx 抛错', async () => {
    const fetchMock = vi.fn(
      async () => new Response('nope', { status: 500, statusText: 'Server Error' }),
    )

    await expect(
      fetchRest(
        { kind: 'rest', url: '/api/users' },
        { fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow('HTTP 500 Server Error')
  })

  it('按 responseType 解析文本、空 JSON 与非法 JSON', async () => {
    const textMock = vi.fn(async () => new Response('hello'))
    await expect(
      fetchRest(
        { kind: 'rest', url: '/api/text', responseType: 'text' },
        { fetchImpl: textMock as unknown as typeof fetch },
      ),
    ).resolves.toBe('hello')

    const emptyMock = vi.fn(async () => new Response(''))
    await expect(
      fetchRest(
        { kind: 'rest', url: '/api/empty' },
        { fetchImpl: emptyMock as unknown as typeof fetch },
      ),
    ).resolves.toBeNull()

    const invalidMock = vi.fn(async () => new Response('not json'))
    await expect(
      fetchRest(
        { kind: 'rest', url: '/api/invalid' },
        { fetchImpl: invalidMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow('响应不是合法 JSON（GET /api/invalid）')
  })
})
