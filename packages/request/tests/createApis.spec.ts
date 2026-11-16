import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { describe, expect, it, vi } from 'vitest'

import { createApis, createRequest, RequestError } from '../src/index'
import type { ApiConfigMap, RequestErrorType } from '../src/index'

/**
 * 验证 createApis 对外承诺：批量生成方法、共享实例配置、参数作为 baseData 传入。
 * 仍用 axios 自定义 adapter 替换网络边界，让断言落在真正交给 axios 的配置上。
 */

type AdapterBehavior = (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>

/** 构造一个固定响应的 adapter，连同完整 AxiosResponse 形状一起返回。 */
function reply(payload: unknown): AdapterBehavior {
  return async (config) => ({
    data: payload,
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  })
}

describe('createApis：批量创建方法', () => {
  it('为每个配置项生成同名方法，调用后解析为 dataPath 解包后的数据', async () => {
    const adapter = vi.fn(reply({ code: '0', data: { id: 'u1' } }))

    const apis = createApis(
      {
        getUser: { url: '/user', dataPath: 'data' },
        getOrder: { url: '/order', dataPath: 'data' },
      },
      {
        axiosConfig: {
          transformRequest: [(data: unknown) => data],
          adapter,
        },
      },
    )

    expect(Object.keys(apis)).toEqual(['getUser', 'getOrder'])

    await expect(apis.getUser()).resolves.toMatchObject({ id: 'u1' })
    await expect(apis.getOrder()).resolves.toMatchObject({ id: 'u1' })
    expect(adapter).toHaveBeenCalledTimes(2)
  })

  it('方法入参作为 baseData 传给 data/params/method 的动态函数', async () => {
    const adapter = vi.fn(reply({ code: '0', data: { ok: true } }))
    const dataFn = vi.fn((params: { id: string }) => ({ bodyId: params.id }))
    const paramsFn = vi.fn((params: { id: string }) => ({ queryId: params.id }))
    const methodFn = vi.fn((params: { id: string }) => (params.id ? 'POST' : 'GET'))

    const apis = createApis(
      {
        submit: {
          url: '/submit',
          data: dataFn,
          params: paramsFn,
          method: methodFn,
        },
      },
      {
        axiosConfig: {
          transformRequest: [(data: unknown) => data],
          adapter,
        },
      },
    )

    const input = { id: 'x-1' }
    await apis.submit(input)

    expect(dataFn).toHaveBeenCalledWith(input)
    expect(paramsFn).toHaveBeenCalledWith(input)
    expect(methodFn).toHaveBeenCalledWith(input)

    const sent = adapter.mock.calls[0][0]
    expect(sent.method).toBe('post')
    expect(sent.data).toEqual({ bodyId: 'x-1' })
    expect(sent.params).toEqual({ queryId: 'x-1' })
  })

  it('before 返回 false 时方法解析为 undefined 且不发请求', async () => {
    const adapter = vi.fn(reply({ code: '0', data: { ok: true } }))

    const apis = createApis(
      {
        guarded: {
          url: '/guarded',
          before: () => false,
        },
      },
      {
        axiosConfig: {
          transformRequest: [(data: unknown) => data],
          adapter,
        },
      },
    )

    await expect(apis.guarded()).resolves.toBeUndefined()
    expect(adapter).not.toHaveBeenCalled()
  })

  it('共享实例级 netType/baseURLs 映射', async () => {
    const adapter = vi.fn(reply({ code: '0', data: { ok: true } }))

    const apis = createApis(
      {
        a: { url: '/a', netType: 'api' },
        b: { url: '/b', netType: 'api' },
      },
      {
        netType: 'api',
        baseURLs: { api: 'https://api.example.com' },
        axiosConfig: {
          transformRequest: [(data: unknown) => data],
          adapter,
        },
      },
    )

    await apis.a()
    await apis.b()

    expect(adapter.mock.calls[0][0].baseURL).toBe('https://api.example.com')
    expect(adapter.mock.calls[1][0].baseURL).toBe('https://api.example.com')
  })

  it('业务 code 失败时方法 reject RequestError，errType 为 response', async () => {
    const adapter = vi.fn(reply({ code: '500', message: 'boom', data: null }))
    const error = vi.fn()

    const apis = createApis(
      {
        fail: { url: '/fail', error },
      },
      {
        axiosConfig: {
          transformRequest: [(data: unknown) => data],
          adapter,
        },
      },
    )

    let caught: unknown
    try {
      await apis.fail()
    } catch (error_) {
      caught = error_
    }

    expect(caught).toBeInstanceOf(RequestError)
    expect((caught as RequestError).type).toBe('response' satisfies RequestErrorType)
    expect(error).toHaveBeenCalledWith(caught, 'response')
  })

  it('netType 的类型约束在编译期生效（见下方 typeChecks 函数）', () => {
    // 运行时断言是占位：真正的约束由 typecheck 阶段对 typeChecks 的解析验证。
    expect(typeof createRequest).toBe('function')
  })

  it('配置可用 satisfies ApiConfigMap 声明以保留键名', async () => {
    const adapter = vi.fn(reply({ code: '0', data: { ok: true } }))

    const apis = createApis(
      {
        only: { url: '/only' },
      } satisfies ApiConfigMap,
      {
        axiosConfig: {
          transformRequest: [(data: unknown) => data],
          adapter,
        },
      },
    )

    await expect(apis.only()).resolves.toMatchObject({ ok: true })
  })
})

/**
 * 编译期类型约束验证：本函数从不执行，仅由 tsconfig 的类型检查解析。
 *
 * @ts-expect-error 若约束失效（错误 netType 不再报错），tsc 会反向报
 * 「Unused '@ts-expect-error' directive」，从而让约束失效变成构建失败。
 */
function netTypeConstraintTypeChecks(): void {
  const request = createRequest({
    baseURLs: { api: 'https://api.example.com', admin: 'https://admin.example.com' },
  })

  void request({ url: '/ok', netType: 'api' })

  // @ts-expect-error netType 必须是 baseURLs 的键
  void request({ url: '/bad', netType: 'unknown' })

  createApis(
    {
      ok: { url: '/ok', netType: 'admin' },
      bad: {
        url: '/bad',
        // @ts-expect-error configMap 内的 netType 同样受 baseURLs 键约束
        netType: 'unknown',
      },
    },
    { baseURLs: { api: 'https://api.example.com', admin: 'https://admin.example.com' } },
  )
}

void netTypeConstraintTypeChecks
