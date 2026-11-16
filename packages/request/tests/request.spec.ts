import { AxiosError, AxiosHeaders } from 'axios'
import type { AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { describe, expect, it, vi } from 'vitest'

import { createRequest, RequestError } from '../src/index'
import type { RequestDefaults, RequestFunction } from '../src/index'
import { getValueByPath, resolveMixin, toCodeList } from '../src/utils'

/**
 * 独立验证 @lc/request 对外承诺的语义，而不是复述实现。
 *
 * 用 axios 自定义 adapter 替换网络边界（而非 vi.mock('axios')）：instance.request 的
 * 配置合并与 axios.isAxiosError 都走真实实现，避免用假的 isAxiosError 让错误分支
 * 「假通过」。adapter 同时是断言入口，可直接检查真正交给 axios 的配置。
 */

type AdapterBehavior = (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>

/** 构造一个固定响应的 adapter，并带上完整 AxiosResponse 形状。 */
function reply(payload: unknown): AdapterBehavior {
  return async (config) => ({
    data: payload,
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  })
}

function createHarness<B = unknown>(
  behavior: AdapterBehavior,
  defaults: RequestDefaults<B> = {},
) {
  const adapter = vi.fn(behavior)
  const request: RequestFunction<B> = createRequest<B>({
    ...defaults,
    axiosConfig: {
      // 让 data 原样到达 adapter：断言聚焦本封装的语义，而不是 axios 的 JSON 序列化。
      transformRequest: [(data: unknown) => data],
      ...defaults.axiosConfig,
      adapter,
    },
  })
  return { request, adapter }
}

/** 明确失败路径：resolved 视为测试失败，避免「catch 到 undefined」的误判。 */
async function rejection<T = RequestError>(promise: Promise<unknown>): Promise<T> {
  try {
    await promise
  } catch (error) {
    return error as T
  }
  throw new Error('期望 Promise reject，但实际 resolved')
}

describe('成功路径：解包、格式化与回调', () => {
  it('默认 dataPath 解包 data；format 先于 success，两者都拿到格式化后的数据', async () => {
    // Arrange
    const body = { code: '0', data: { id: 'u1', name: 'Ada' } }
    const { request } = createHarness(reply(body))
    const order: string[] = []
    const format = vi.fn((data: { id: string; name: string }) => {
      order.push('format')
      return { ...data, tag: 'formatted' }
    })
    const success = vi.fn(() => {
      order.push('success')
    })

    // Act
    const result = await request<{ id: string; name: string }>({
      url: '/user/detail',
      format,
      success,
    })

    // Assert
    expect(result).toEqual({ id: 'u1', name: 'Ada', tag: 'formatted' })
    expect(format).toHaveBeenCalledTimes(1)
    expect(format).toHaveBeenCalledWith({ id: 'u1', name: 'Ada' })
    expect(success).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledWith(
      { id: 'u1', name: 'Ada', tag: 'formatted' },
      body, // ret 是未解包的完整响应体
    )
    expect(order).toEqual(['format', 'success'])
  })

  it('before 返回 false：不发请求、不格式化、不回调，Promise 解析为 undefined', async () => {
    const { request, adapter } = createHarness(reply({ code: '0', data: { ok: true } }))
    const before = vi.fn(() => false)
    const format = vi.fn((data: unknown) => data)
    const success = vi.fn()

    const result = await request({ url: '/u', data: { x: 1 }, before, format, success })

    expect(result).toBeUndefined()
    expect(adapter).not.toHaveBeenCalled()
    expect(before).toHaveBeenCalledTimes(1)
    expect(format).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
  })

  it('before 收到已解析的 data / baseData 和含 baseURL 的 axios 配置', async () => {
    const { request } = createHarness<{ tenantId: string }>(reply({ code: '0', data: {} }), {
      baseURLs: { api: 'https://api.test' },
      netType: 'api',
    })
    const before = vi.fn(
      (_options: {
        config: AxiosRequestConfig
        data?: { tenant: string }
        baseData?: { tenantId: string }
      }) => true,
    )

    await request(
      { url: '/u', data: (baseData) => ({ tenant: baseData.tenantId }), before },
      { tenantId: 't-9' },
    )

    const options = before.mock.calls[0][0]
    expect(options.data).toEqual({ tenant: 't-9' })
    expect(options.baseData).toEqual({ tenantId: 't-9' })
    expect(options.config.baseURL).toBe('https://api.test')
    expect(options.config.url).toBe('/u')
  })

  it('data / params / method 的函数形式都收到 baseData 并生效', async () => {
    const { request, adapter } = createHarness<{ tenantId: string }>(
      reply({ code: '0', data: {} }),
    )

    await request<{ ok: boolean }, { tenant: string }>(
      {
        url: '/dynamic',
        method: (baseData) => (baseData.tenantId ? 'post' : 'get'),
        data: (baseData) => ({ tenant: baseData.tenantId }),
        params: (baseData) => ({ tenant: baseData.tenantId }),
      },
      { tenantId: 't-1' },
    )

    const sent = adapter.mock.calls[0][0]
    expect(String(sent.method).toUpperCase()).toBe('POST')
    expect(sent.data).toEqual({ tenant: 't-1' })
    expect(sent.params).toEqual({ tenant: 't-1' })
  })

  it('原生 axios 配置透传，且封装自定义字段不泄漏给 axios', async () => {
    const controller = new AbortController()
    const { request, adapter } = createHarness(reply({ code: '0', data: { ok: true } }), {
      baseURLs: { api: 'https://api.test' },
    })

    await request({
      url: '/u',
      headers: { 'X-Trace': 'abc' },
      timeout: 4321,
      signal: controller.signal,
      dataPath: 'data',
      includeCode: '0',
      excludeCode: '500',
      codePath: 'code',
      netType: 'api',
      before: () => undefined,
      format: (data: Record<string, unknown>) => data,
      success: () => undefined,
      error: () => undefined,
    })

    const sent = adapter.mock.calls[0][0]
    expect(sent.url).toBe('/u')
    expect(sent.timeout).toBe(4321)
    expect(sent.signal).toBe(controller.signal)
    expect(AxiosHeaders.from(sent.headers).get('X-Trace')).toBe('abc')

    // 这些是封装自己的语义字段，传入 axios 只会污染Adapter配置。
    for (const key of [
      'dataPath',
      'includeCode',
      'excludeCode',
      'codePath',
      'netType',
      'before',
      'format',
      'success',
      'error',
    ]) {
      expect(sent).not.toHaveProperty(key)
    }
  })
})

describe('netType 与 baseURL 优先级', () => {
  it('netType 命中实例 baseURLs 映射', async () => {
    const { request, adapter } = createHarness(reply({ code: '0', data: {} }), {
      baseURLs: { api: 'https://api.example.com' },
      netType: 'api',
    })

    await request({ url: '/u' })

    expect(adapter.mock.calls[0][0].baseURL).toBe('https://api.example.com')
  })

  it('未映射的 netType：不发请求，reject catch 类 RequestError，并触发两级错误回调', async () => {
    const { request, adapter } = createHarness(reply({ code: '0', data: {} }), {
      baseURLs: { api: 'https://api.example.com' },
      netType: 'missing',
      onError: vi.fn(),
    })
    const error = vi.fn()

    const err = await rejection<RequestError>(request({ url: '/u', error }))

    expect(err).toBeInstanceOf(RequestError)
    expect(err.type).toBe('catch')
    expect(err.message).toContain('未配置 netType')
    expect(adapter).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(err, 'catch')
    // 配置阶段错误不是 excludeCode 命中，全局 onError 应照常执行
    expect(err.isExclude).toBe(false)
  })

  it('单次 baseURL 优先于 netType 映射', async () => {
    const { request, adapter } = createHarness(reply({ code: '0', data: {} }), {
      baseURLs: { api: 'https://api.example.com' },
      netType: 'api',
    })

    await request({ url: '/u', baseURL: 'https://single.example.com' })

    expect(adapter.mock.calls[0][0].baseURL).toBe('https://single.example.com')
  })

  it('netType 优先于实例 axiosConfig.baseURL', async () => {
    const { request, adapter } = createHarness(reply({ code: '0', data: {} }), {
      baseURLs: { api: 'https://api.example.com' },
      netType: 'api',
      axiosConfig: { baseURL: 'https://instance.example.com' },
    })

    await request({ url: '/u' })

    expect(adapter.mock.calls[0][0].baseURL).toBe('https://api.example.com')
  })

  it('单次 netType 覆盖实例默认 netType', async () => {
    const { request, adapter } = createHarness(reply({ code: '0', data: {} }), {
      baseURLs: { api: 'https://api.example.com', admin: 'https://admin.example.com' },
      netType: 'api',
    })

    await request({ url: '/u', netType: 'admin' })

    expect(adapter.mock.calls[0][0].baseURL).toBe('https://admin.example.com')
  })
})

describe('dataPath 解包语义', () => {
  const body = { code: '0', data: { list: [1, 2], total: 2 } }

  it('点语法 data.list 取到嵌套数据', async () => {
    const { request } = createHarness(reply(body))

    expect(await request({ url: '/u', dataPath: 'data.list' })).toEqual([1, 2])
  })

  it('dataPath=false 返回完整响应体（信封）', async () => {
    const { request } = createHarness(reply(body))

    expect(await request({ url: '/u', dataPath: false })).toEqual(body)
  })

  it('dataPath=true 等价默认 data；实例默认 dataPath 生效且可被单次覆盖', async () => {
    const { request } = createHarness(reply(body))

    expect(await request({ url: '/u', dataPath: true })).toEqual(body.data)
    expect(await request({ url: '/u' })).toEqual(body.data)

    const withDefault = createHarness(reply(body), { dataPath: 'data.list' })
    expect(await withDefault.request({ url: '/u' })).toEqual([1, 2])
    expect(await withDefault.request({ url: '/u', dataPath: false })).toEqual(body)
  })

  it('dataPath 命中原型链关键字时安全返回 undefined，而不抛异常', async () => {
    const { request } = createHarness(reply(body))

    expect(await request({ url: '/u', dataPath: '__proto__.polluted' })).toBeUndefined()
  })
})

describe('业务 code 判定', () => {
  it('失败 code：reject response 类错误，code/message 正确，两级回调收到 response', async () => {
    const body = { code: '500', data: { msg: 'fail' } }
    const onError = vi.fn()
    const { request } = createHarness(reply(body), { onError })
    const error = vi.fn()

    const err = await rejection<RequestError>(request({ url: '/u', error }))

    expect(err).toBeInstanceOf(RequestError)
    expect(err.type).toBe('response')
    expect(err.code).toBe('500')
    expect(err.message).toContain('请求失败，code=500')
    expect(err.isExclude).toBe(false)
    expect(error).toHaveBeenCalledWith(err, 'response')
    expect(onError).toHaveBeenCalledWith(err, 'response')
  })

  it('响应没有 code 字段一律视为成功', async () => {
    const body = { data: { ok: true } }
    const { request } = createHarness(reply(body))

    expect(await request({ url: '/u' })).toEqual({ ok: true })
  })

  it('数字 code 与默认字符串成功列表匹配（200 与 0）', async () => {
    const ok200 = createHarness(reply({ code: 200, data: { ok: true } }))
    expect(await ok200.request({ url: '/u' })).toEqual({ ok: true })

    const ok0 = createHarness(reply({ code: 0, data: { ok: true } }))
    expect(await ok0.request({ url: '/u' })).toEqual({ ok: true })
  })

  it('自定义 includeCode 与实例级默认值生效，数字响应码按字符串比较', async () => {
    const { request } = createHarness(reply({ code: '1001', data: { ok: true } }))
    expect(await request({ url: '/u', includeCode: '1001' })).toEqual({ ok: true })

    const numeric = createHarness(reply({ code: 42, data: { ok: true } }))
    expect(await numeric.request({ url: '/u', includeCode: ['42'] })).toEqual({ ok: true })

    const defaulted = createHarness(reply({ code: '1001', data: { ok: true } }), {
      includeCode: '1001',
    })
    expect(await defaulted.request({ url: '/u' })).toEqual({ ok: true })
  })

  it('空 includeCode 数组 = 没有任何成功 code：带 code 的响应失败，无 code 的响应仍成功', async () => {
    // 依据 README：只有「无 code 字段」是无条件成功；空数组不是「回退默认值」。
    const withCode = createHarness(reply({ code: '0', data: { ok: true } }))
    const err = await rejection<RequestError>(withCode.request({ url: '/u', includeCode: [] }))
    expect(err.type).toBe('response')
    expect(err.code).toBe('0')

    const withoutCode = createHarness(reply({ data: { ok: true } }))
    expect(await withoutCode.request({ url: '/u', includeCode: [] })).toEqual({ ok: true })
  })

  it('codePath 点语法在请求级与实例级都生效，失败时 code 来自该路径', async () => {
    const body = { meta: { status: '0' }, data: { ok: true } }
    const fromConfig = createHarness(reply(body))
    expect(await fromConfig.request({ url: '/u', codePath: 'meta.status' })).toEqual({
      ok: true,
    })

    const fromDefaults = createHarness(reply(body), { codePath: 'meta.status' })
    expect(await fromDefaults.request({ url: '/u' })).toEqual({ ok: true })

    const failing = createHarness(reply({ meta: { status: 'E1' }, data: {} }))
    const err = await rejection<RequestError>(
      failing.request({ url: '/u', codePath: 'meta.status' }),
    )
    expect(err.code).toBe('E1')
    expect(err.type).toBe('response')
  })

  it('excludeCode 命中：isExclude=true、请求级 error 执行、全局 onError 跳过', async () => {
    const onError = vi.fn()
    const error = vi.fn()
    const { request } = createHarness(reply({ code: '401', data: {} }), { onError })

    const err = await rejection<RequestError>(
      request({ url: '/u', error, excludeCode: ['401'] }),
    )

    expect(err.isExclude).toBe(true)
    expect(err.code).toBe('401')
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(err, 'response')
    expect(onError).not.toHaveBeenCalled()
  })

  it('实例级 excludeCode 同样生效', async () => {
    const onError = vi.fn()
    const { request } = createHarness(reply({ code: '401', data: {} }), {
      excludeCode: '401',
      onError,
    })

    const err = await rejection<RequestError>(request({ url: '/u' }))

    expect(err.isExclude).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('网络与 axios 异常的归类', () => {
  it('带 response 的 AxiosError 归为 response，并读取响应里的 code', async () => {
    let response: AxiosResponse | undefined
    const error = vi.fn()
    const onError = vi.fn()
    const { request } = createHarness(
      async (config) => {
        response = {
          data: { code: '500', data: null },
          status: 500,
          statusText: 'Server Error',
          headers: {},
          config,
        }
        throw new AxiosError(
          'Request failed with status code 500',
          'ERR_BAD_RESPONSE',
          config,
          undefined,
          response,
        )
      },
      { onError },
    )

    const err = await rejection<RequestError>(request({ url: '/u', error }))

    expect(err).toBeInstanceOf(RequestError)
    expect(err.type).toBe('response')
    expect(err.code).toBe('500')
    expect(err.response).toBe(response)
    expect(err.message).toBe('Request failed with status code 500')
    expect(error).toHaveBeenCalledWith(err, 'response')
    expect(onError).toHaveBeenCalledWith(err, 'response')
  })

  it('无 response 的 AxiosError 归为 catch', async () => {
    const { request } = createHarness(async (config) => {
      throw new AxiosError('Network Error', 'ERR_NETWORK', config)
    })
    const error = vi.fn()

    const err = await rejection<RequestError>(request({ url: '/u', error }))

    expect(err.type).toBe('catch')
    expect(err.response).toBeUndefined()
    expect(err.message).toBe('Network Error')
    expect(error).toHaveBeenCalledWith(err, 'catch')
  })

  it('AxiosError 响应中的业务 code 命中 excludeCode 时跳过全局 onError', async () => {
    const onError = vi.fn()
    const { request } = createHarness(
      async (config) => {
        throw new AxiosError('Unauthorized', 'ERR_BAD_RESPONSE', config, undefined, {
          data: { code: '401' },
          status: 401,
          statusText: 'Unauthorized',
          headers: {},
          config,
        })
      },
      { onError },
    )
    const error = vi.fn()

    const err = await rejection<RequestError>(request({ url: '/u', error, excludeCode: '401' }))

    expect(err.type).toBe('response')
    expect(err.code).toBe('401')
    expect(err.isExclude).toBe(true)
    expect(error).toHaveBeenCalledWith(err, 'response')
    expect(onError).not.toHaveBeenCalled()
  })

  it('非 axios 异常（如序列化抛错）归为 catch，保留原始 message 与 cause', async () => {
    const original = new Error('boom')
    const { request } = createHarness(async () => {
      throw original
    })

    const err = await rejection<RequestError>(request({ url: '/u' }))

    expect(err.type).toBe('catch')
    expect(err.message).toBe('boom')
    expect(err.cause).toBe(original)
  })
})

describe('回调自身抛错时原样传播', () => {
  it('success 抛出的错误不被包装成 RequestError', async () => {
    const boom = new Error('success boom')
    const { request } = createHarness(reply({ code: '0', data: { ok: true } }))

    const caught = await rejection<Error>(
      request({
        url: '/u',
        success: () => {
          throw boom
        },
      }),
    )

    expect(caught).toBe(boom)
  })

  it('error 抛出的错误原样向外传播', async () => {
    const boom = new Error('error boom')
    const { request } = createHarness(reply({ code: '500', data: {} }))

    const caught = await rejection<Error>(
      request({
        url: '/u',
        error: () => {
          throw boom
        },
      }),
    )

    expect(caught).toBe(boom)
  })
})

describe('utils：纯函数边界', () => {
  it('getValueByPath 支持点路径与数组下标', () => {
    expect(getValueByPath({ list: [{ id: 7 }] }, 'list.0.id')).toBe(7)
    expect(getValueByPath({ a: { b: 'v' } }, 'a.b')).toBe('v')
  })

  it('getValueByPath 对缺失字段、null/原始类型中断均返回 undefined', () => {
    expect(getValueByPath({ a: 1 }, 'a.b')).toBeUndefined()
    expect(getValueByPath(undefined, 'a')).toBeUndefined()
    expect(getValueByPath(null, 'a')).toBeUndefined()
    expect(getValueByPath({ a: null }, 'a.b')).toBeUndefined()
    expect(getValueByPath({ a: {} }, '')).toBeUndefined()
  })

  it('getValueByPath 拦截 __proto__ / prototype / constructor', () => {
    expect(getValueByPath({}, '__proto__')).toBeUndefined()
    expect(
      getValueByPath({ a: { prototype: 1, constructor: 2 } }, 'a.prototype'),
    ).toBeUndefined()
    expect(getValueByPath({ a: { constructor: 2 } }, 'a.constructor')).toBeUndefined()
    expect(getValueByPath({ a: {} }, 'a.__proto__')).toBeUndefined()
  })

  it('resolveMixin：静态值原样返回，函数值只调用一次并收到 baseData', () => {
    expect(resolveMixin(undefined, 'base')).toBeUndefined()
    expect(resolveMixin(7, 'base')).toBe(7)

    const dynamic = vi.fn((baseData: string) => `v-${baseData}`)
    expect(resolveMixin(dynamic, 'base')).toBe('v-base')
    expect(dynamic).toHaveBeenCalledTimes(1)
    expect(dynamic).toHaveBeenCalledWith('base')
  })

  it('toCodeList：undefined 保留，字符串与数组统一转字符串', () => {
    expect(toCodeList(undefined)).toBeUndefined()
    expect(toCodeList('0')).toEqual(['0'])
    // 故意传入数字：后端 code 可能是数字，toCodeList 必须在边界上统一转字符串。
    expect(toCodeList(['0', 200] as unknown as string[])).toEqual(['0', '200'])
  })
})
