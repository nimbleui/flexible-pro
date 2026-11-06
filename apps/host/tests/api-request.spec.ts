import { describe, expect, it, vi } from 'vitest'
import type { ProjectApi } from '@lc/schema'
import { sendApiRequest } from '../src/apis/api-request'

/**
 * 调试台的请求执行。
 *
 * 这里的每条断言都在保证「调试看到的就是运行时得到的」：地址拼接、query 合并、GET 不带
 * body、凭据映射、非 2xx 判失败、JSON 解析失败留原文。任何一条与运行时数据源走偏，
 * 调试通过就变成误导。
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

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('调试请求的地址与请求初始化', () => {
  it('相对路径拼项目前缀，query 参数并进地址', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ id: 1 }]))
    const result = await sendApiRequest(
      makeApi({ params: { page: '2', q: 'a b' } }),
      { baseUrl: 'https://api.test/svc' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    )

    expect(result.url).toBe('https://api.test/svc/users?page=2&q=a+b')
    expect(result.ok).toBe(true)
    expect(result.body).toEqual([{ id: 1 }])
  })

  it('项目默认头与默认参数进得了调试请求，请求自己写的同名值不被覆盖', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(null),
    )
    await sendApiRequest(
      makeApi({ headers: { 'X-Scope': 'local' }, params: { page: '9' } }),
      {
        baseUrl: '/svc',
        headers: { Authorization: 'Bearer t', 'X-Scope': 'global' },
        params: { tenant: 'acme', page: '1' },
      },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    )

    // 调试台与运行时共用 mergeRequestDefaults：这条断言成立，才没有「调试通、页面不通」
    const sentUrl = String(fetchMock.mock.calls[0]?.[0])
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    const headers = new Headers(init?.headers)

    expect(sentUrl).toBe('/svc/users?page=9&tenant=acme')
    expect(headers.get('authorization')).toBe('Bearer t')
    expect(headers.get('x-scope')).toBe('local')
  })

  it('地址已带查询串时用 & 续接，不产生 ??', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(null))
    const result = await sendApiRequest(
      makeApi({ path: '/users?x=1', params: { page: '2' } }),
      undefined,
      { fetchImpl: fetchMock as unknown as typeof fetch },
    )

    expect(result.url).toBe('/users?x=1&page=2')
  })

  it('POST 带 body 时自动补 Content-Type，已显式声明则不覆盖', async () => {
    const autoMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true }),
    )
    await sendApiRequest(makeApi({ method: 'POST', body: { name: 'Alice' } }), undefined, {
      fetchImpl: autoMock as unknown as typeof fetch,
    })
    const autoInit = autoMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(autoInit?.body).toBe('{"name":"Alice"}')
    expect(new Headers(autoInit?.headers).get('content-type')).toBe('application/json')

    const keepMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true }),
    )
    await sendApiRequest(
      makeApi({
        method: 'POST',
        body: 'name=Alice',
        headers: { 'Content-Type': 'text/plain' },
      }),
      undefined,
      { fetchImpl: keepMock as unknown as typeof fetch },
    )
    const keepInit = keepMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(new Headers(keepInit?.headers).get('content-type')).toBe('text/plain')
  })

  it('GET 永不带 body，withCredentials 映射到 credentials', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(null),
    )
    await sendApiRequest(
      makeApi({ body: { ignored: true }, withCredentials: true }),
      undefined,
      { fetchImpl: fetchMock as unknown as typeof fetch },
    )

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(init?.body).toBeUndefined()
    expect(init?.credentials).toBe('include')
  })

  it('没有路径时连请求都不发', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(null))
    const result = await sendApiRequest(makeApi({ path: '  ' }), undefined, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('请求路径')
  })
})

describe('调试请求的结果与失败编码', () => {
  it('非 2xx 判失败但不抛异常，状态码仍然回得来', async () => {
    const fetchMock = vi.fn(
      async () => new Response('nope', { status: 500, statusText: 'Server Error' }),
    )
    const result = await sendApiRequest(makeApi(), undefined, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(500)
    expect(result.error).toBe('HTTP 500 Server Error')
  })

  it('响应不是 JSON 时保留原文：能区分接口挂了与返回了登录页', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>login</html>'))
    const result = await sendApiRequest(makeApi(), undefined, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result.error).toBe('响应不是合法 JSON')
    expect(result.rawText).toBe('<html>login</html>')
  })

  it('空响应体不算解析失败', async () => {
    const fetchMock = vi.fn(async () => new Response(''))
    const result = await sendApiRequest(makeApi(), undefined, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.body).toBeUndefined()
  })

  it('responseType 为 text 时原文即结果，不走 JSON 解析', async () => {
    const fetchMock = vi.fn(async () => new Response('not json'))
    const result = await sendApiRequest(makeApi({ responseType: 'text' }), undefined, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result.body).toBe('not json')
  })

  it('fetch 抛错即网络失败，错误文案里带上 CORS 提示', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const result = await sendApiRequest(makeApi(), undefined, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(0)
    expect(result.error).toBe('请求失败：Failed to fetch（跨域目标需要允许 CORS）')
  })

  it('取消请求单独成文案，不混进网络失败', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    const result = await sendApiRequest(makeApi(), undefined, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result.error).toBe('已取消')
  })
})
