import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { configureRequest, createApis, getRequest, resetRequest } from '../src/index'

/**
 * 验证全局共享实例与拦截器语义。
 *
 * 仍用 axios 自定义 adapter 替换网络边界：configureRequest 时把 adapter 放进 axiosConfig，
 * 这样断言能落在真正发出的请求配置（含拦截器注入的 header）上。
 * 每个用例后 resetRequest，避免单例状态在用例间泄漏。
 */

type AdapterBehavior = (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>

function reply(payload: unknown): AdapterBehavior {
  return async (config) => ({
    data: payload,
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  })
}

afterEach(() => {
  resetRequest()
})

describe('全局共享实例', () => {
  it('createApis 不传 options 时复用 configureRequest 配置的实例', async () => {
    const adapter = vi.fn(reply({ code: '0', data: { ok: true } }))
    configureRequest({
      axiosConfig: { transformRequest: [(data: unknown) => data], adapter },
    })

    const apiA = createApis({ a: { url: '/a' } })
    const apiB = createApis({ b: { url: '/b' } })

    await apiA.a()
    await apiB.b()

    // 两次 createApis 命中同一个 adapter：证明没有各自重建实例。
    expect(adapter).toHaveBeenCalledTimes(2)
    expect(getRequest()).toBe(getRequest())
  })

  it('未配置时 getRequest 惰性创建，createApis 仍可工作', async () => {
    // 不调用 configureRequest，直接 createApis。
    const apis = createApis({ only: { url: '/only', dataPath: false } })
    expect(typeof apis.only).toBe('function')
  })

  it('传入 defaults 时创建独立实例，不影响全局实例', async () => {
    const globalAdapter = vi.fn(reply({ code: '0', data: { from: 'global' } }))
    const ownAdapter = vi.fn(reply({ code: '0', data: { from: 'own' } }))
    configureRequest({
      axiosConfig: { transformRequest: [(data: unknown) => data], adapter: globalAdapter },
    })

    const ownApis = createApis(
      { own: { url: '/own' } },
      { axiosConfig: { transformRequest: [(data: unknown) => data], adapter: ownAdapter } },
    )
    const globalApis = createApis({ global: { url: '/global' } })

    await expect(ownApis.own()).resolves.toMatchObject({ from: 'own' })
    await expect(globalApis.global()).resolves.toMatchObject({ from: 'global' })
    expect(ownAdapter).toHaveBeenCalledTimes(1)
    expect(globalAdapter).toHaveBeenCalledTimes(1)
  })

  it('configureRequest 重复调用会替换实例而非叠加拦截器', async () => {
    const adapter = vi.fn(reply({ code: '0', data: { ok: true } }))
    const seen: number[] = []

    configureRequest({
      axiosConfig: { transformRequest: [(data: unknown) => data], adapter },
      interceptors: {
        request: (config) => {
          seen.push(1)
          return config
        },
      },
    })
    configureRequest({
      axiosConfig: { transformRequest: [(data: unknown) => data], adapter },
      interceptors: {
        request: (config) => {
          seen.push(2)
          return config
        },
      },
    })

    const apis = createApis({ a: { url: '/a' } })
    await apis.a()

    expect(seen).toEqual([2])
  })
})

describe('拦截器', () => {
  it('请求拦截器注入 token，所有复用实例的请求都带上', async () => {
    const adapter = vi.fn(reply({ code: '0', data: { ok: true } }))
    configureRequest({
      axiosConfig: { transformRequest: [(data: unknown) => data], adapter },
      interceptors: {
        request: (config) => {
          config.headers.set('Authorization', 'Bearer token-123')
          return config
        },
      },
    })

    const apis = createApis({ a: { url: '/a' }, b: { url: '/b' } })
    await apis.a()
    await apis.b()

    expect(adapter.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer token-123')
    expect(adapter.mock.calls[1][0].headers.get('Authorization')).toBe('Bearer token-123')
  })

  it('响应拦截器先于业务解析执行，可改写响应数据', async () => {
    const adapter = vi.fn(reply({ code: '0', data: { count: 1 } }))
    configureRequest({
      axiosConfig: { transformRequest: [(data: unknown) => data], adapter },
      interceptors: {
        response: (response) => ({
          ...response,
          data: { code: '0', data: { ...response.data.data, touched: true } },
        }),
      },
    })

    const apis = createApis({ a: { url: '/a' } })
    await expect(apis.a()).resolves.toMatchObject({ count: 1, touched: true })
  })

  it('响应错误拦截器可恢复错误，请求不再 reject', async () => {
    const adapter = vi.fn(
      async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
        throw { message: 'network down', config }
      },
    )
    configureRequest({
      axiosConfig: { transformRequest: [(data: unknown) => data], adapter },
      interceptors: {
        // 恢复值会成为后续解析的 AxiosResponse，必须带完整 data 信封才能被 code 判定与 dataPath 解包。
        responseError: (error) => ({
          data: { code: '0', data: { recovered: true } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: (error as { config: InternalAxiosRequestConfig }).config,
        }),
      },
    })

    const apis = createApis({ a: { url: '/a' } })
    await expect(apis.a()).resolves.toMatchObject({ recovered: true })
  })

  it('请求拦截器抛错时归一为 RequestError 并走 error 回调', async () => {
    const adapter = vi.fn(reply({ code: '0', data: { ok: true } }))
    configureRequest({
      axiosConfig: { transformRequest: [(data: unknown) => data], adapter },
      interceptors: {
        request: () => {
          throw new Error('no token')
        },
      },
    })

    const error = vi.fn()
    const apis = createApis({ a: { url: '/a', error } })

    let caught: unknown
    try {
      await apis.a()
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect(error).toHaveBeenCalledTimes(1)
    expect(adapter).not.toHaveBeenCalled()
  })
})
