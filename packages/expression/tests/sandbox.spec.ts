import { describe, expect, it, vi } from 'vitest'
import type { ExpressionError, SandboxRequest, SandboxResponse } from '../src/index'
import {
  SANDBOX_PROTOCOL_VERSION,
  SandboxTransportError,
  createExpressionEngine,
  createExpressionSandbox,
  createSandboxEndpoint,
  serveSandboxOnPort,
} from '../src/index'
import type { SandboxTransport } from '../src/index'

/** 构造一条求值请求；测试里直接驱动端点时用 */
function invokeRequest(
  input: unknown,
  scope: Record<string, unknown> = {},
  id = 1,
): SandboxRequest {
  return {
    protocol: SANDBOX_PROTOCOL_VERSION,
    kind: 'invoke',
    id,
    operation: 'evaluate',
    input,
    scope,
  }
}

function handle(endpointInput: unknown): SandboxResponse | null {
  return createSandboxEndpoint().handle(endpointInput)
}

/**
 * 回环通道：把客户端与端点接在同一个 tick 里。
 *
 * 它验证的是**协议与客户端行为**，不是隔离强度 —— 同进程内没有真正的 realm 边界。
 * 隔离由「两侧各持有一个独立引擎实例」这一结构性事实保证，本文件末尾有对应断言。
 */
function createLoopback(): { transport: SandboxTransport; closed: () => boolean } {
  const endpoint = createSandboxEndpoint()
  let handler: ((message: unknown) => void) | null = null
  let closed = false

  return {
    closed: () => closed,
    transport: {
      postMessage: (message) => {
        const response = endpoint.handle(message)
        if (response) handler?.(response)
      },
      close: () => {
        closed = true
      },
      onMessage: (next) => {
        handler = next
        return () => {
          handler = null
        }
      },
    },
  }
}

describe('沙箱端点：协议处理', () => {
  it('三种操作各自求值', () => {
    const evaluate = handle(invokeRequest('{{ n * 2 }}', { n: 3 }))
    expect(evaluate).toMatchObject({ kind: 'result', value: 6 })

    const interpolate = handle({
      protocol: SANDBOX_PROTOCOL_VERSION,
      kind: 'invoke',
      id: 2,
      operation: 'interpolate',
      input: '共 {{ n }} 项',
      scope: { n: 4 },
    } satisfies SandboxRequest)
    expect(interpolate).toMatchObject({ kind: 'result', value: '共 4 项' })

    const resolveValue = handle({
      protocol: SANDBOX_PROTOCOL_VERSION,
      kind: 'invoke',
      id: 3,
      operation: 'resolveValue',
      input: { count: { type: 'expression', raw: '{{ n }}' } },
      scope: { n: 9 },
    } satisfies SandboxRequest)
    expect(resolveValue).toMatchObject({ kind: 'result', value: { count: 9 } })
  })

  it('形状非法与版本不符的消息不产生响应', () => {
    expect(handle(null)).toBeNull()
    expect(handle({ kind: 'invoke', id: 1 })).toBeNull()
    expect(handle({ ...invokeRequest('1'), protocol: 999 })).toBeNull()
  })

  it('入参类型不符时回 failure 而不是静默返回', () => {
    const response = handle(invokeRequest(123))
    expect(response).toMatchObject({ kind: 'failure' })
  })

  it('被吞掉的诊断随响应回传', () => {
    const response = handle(invokeRequest('foo.bar.baz', {}))
    const diagnostics =
      (response as Extract<SandboxResponse, { kind: 'result' }>).diagnostics ?? []

    expect(response).toMatchObject({ kind: 'result', value: undefined })
    expect(diagnostics.map((item) => item.kind)).toEqual([
      'unbound-identifier',
      'invalid-operand',
    ])
  })

  it('注册纯 JSON 函数并回报 accepted / rejected', () => {
    const endpoint = createSandboxEndpoint()
    endpoint.handle({
      protocol: SANDBOX_PROTOCOL_VERSION,
      kind: 'register',
      id: 1,
      registrationId: 1,
      level: 'page',
      functions: [
        { name: 'twice', params: ['n'], body: 'n + n' },
        { name: 'round', params: ['n'], body: 'n' },
      ],
    } satisfies SandboxRequest)

    const result = endpoint.handle(invokeRequest('twice(4)', {}, 2))
    expect(result).toMatchObject({ kind: 'result', value: 8 })

    const ack = endpoint.handle({
      protocol: SANDBOX_PROTOCOL_VERSION,
      kind: 'register',
      id: 3,
      registrationId: 2,
      level: 'material',
      functions: [{ name: 'ok', body: '1' }],
    } satisfies SandboxRequest)
    expect(ack).toMatchObject({
      kind: 'result',
      value: { registered: ['ok'], rejected: [] },
    })
  })

  it('注销只撤掉本批注册', () => {
    const endpoint = createSandboxEndpoint()
    const register = (registrationId: number, name: string): void => {
      endpoint.handle({
        protocol: SANDBOX_PROTOCOL_VERSION,
        kind: 'register',
        id: registrationId,
        registrationId,
        level: 'page',
        functions: [{ name, body: `'${name}'` }],
      } satisfies SandboxRequest)
    }

    register(10, 'a')
    register(11, 'b')
    endpoint.handle({
      protocol: SANDBOX_PROTOCOL_VERSION,
      kind: 'unregister',
      id: 12,
      registrationId: 10,
    } satisfies SandboxRequest)

    expect(endpoint.handle(invokeRequest('b()', {}, 13))).toMatchObject({
      kind: 'result',
      value: 'b',
    })
    expect(endpoint.handle(invokeRequest('a()', {}, 14))).toMatchObject({
      kind: 'result',
      value: undefined,
    })
  })

  it('serveSandboxOnPort 把端口消息转成回复', () => {
    const posted: unknown[] = []
    // 用对象持有而不是裸变量：闭包里的赋值不会被控制流分析回填，裸变量在调用点会被收窄成 never
    const binding: { listener: ((event: { data: unknown }) => void) | null } = {
      listener: null,
    }
    const port = {
      postMessage: (message: unknown) => posted.push(message),
      addEventListener: (_type: 'message', handler: (event: { data: unknown }) => void) => {
        binding.listener = handler
      },
      removeEventListener: () => {
        binding.listener = null
      },
    }

    serveSandboxOnPort(port)
    binding.listener?.({ data: invokeRequest('6 * 7') })

    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ kind: 'result', value: 42 })
  })
})

describe('沙箱客户端：通道行为', () => {
  it('求值请求走完整往返', async () => {
    const pair = createLoopback()
    const sandbox = createExpressionSandbox({ createTransport: () => pair.transport })

    await expect(sandbox.evaluate('{{ a + b }}', { a: 1, b: 2 })).resolves.toBe(3)
    await expect(sandbox.interpolate('x{{ a }}', { a: 7 })).resolves.toBe('x7')
    // 混排字符串走插值，结果是字符串；要保留类型得用 ExpressionString 对象
    await expect(sandbox.resolveValue({ v: '{{ a }}' }, { a: 8 })).resolves.toEqual({ v: '8' })
  })

  it('注册回执带 accepted / rejected，并可用 dispose 注销', async () => {
    const pair = createLoopback()
    const sandbox = createExpressionSandbox({ createTransport: () => pair.transport })

    const registration = await sandbox.registerFunctions([
      { name: 'half', params: ['n'], body: 'n / 2' },
      { name: 'max', params: ['n'], body: 'n' },
    ])

    expect(registration.registered).toEqual(['half'])
    expect(registration.rejected).toEqual(['max'])
    await expect(sandbox.evaluate('half(10)', {})).resolves.toBe(5)

    await registration.dispose()
    await expect(sandbox.evaluate('half(10)', {})).resolves.toBeUndefined()
  })

  it('worker 内的诊断回灌到客户端回调', async () => {
    const seen: string[] = []
    const pair = createLoopback()
    const sandbox = createExpressionSandbox({
      createTransport: () => pair.transport,
      onDiagnostic: (error) => seen.push((error as ExpressionError).kind),
    })

    await expect(sandbox.evaluate('foo.bar.baz', {})).resolves.toBeUndefined()
    expect(seen).toEqual(['unbound-identifier', 'invalid-operand'])
  })

  it('端点回 failure 时客户端重建 ExpressionError 抛出', async () => {
    let respond: ((message: unknown) => void) | null = null
    const sandbox = createExpressionSandbox({
      createTransport: () => ({
        postMessage: (message) => {
          const id = (message as { id: number }).id
          queueMicrotask(() =>
            respond?.({
              protocol: SANDBOX_PROTOCOL_VERSION,
              kind: 'failure',
              id,
              error: { kind: 'budget', message: '求值步数超限', expression: 'list.reduce(f)' },
            }),
          )
        },
        close: () => {},
        onMessage: (handler) => {
          respond = handler
          return () => {}
        },
      }),
    })

    const error = await sandbox
      .evaluate('list.reduce(f)', { list: [] })
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as ExpressionError).name).toBe('ExpressionError')
    expect((error as ExpressionError).kind).toBe('budget')
  })

  it('超时终止通道后，下次请求重建并回放此前的函数注册', async () => {
    let instances = 0
    let closedCount = 0

    const sandbox = createExpressionSandbox({
      timeoutMs: 20,
      createTransport: () => {
        instances += 1
        const instance = instances
        let handler: ((message: unknown) => void) | null = null
        const endpoint = createSandboxEndpoint()

        return {
          postMessage: (message) => {
            // 第一个实例只回应注册、不回应对求值 —— 用它制造一次真实的超时
            const request = message as SandboxRequest
            if (instance === 1 && request.kind === 'invoke') return
            const response = endpoint.handle(request)
            if (response) handler?.(response)
          },
          close: () => {
            closedCount += 1
          },
          onMessage: (next) => {
            handler = next
            return () => {}
          },
        }
      },
    })

    const registration = await sandbox.registerFunctions([{ name: 'boom', body: "'boom'" }])
    expect(registration.registered).toEqual(['boom'])

    await expect(sandbox.evaluate('boom()', {})).rejects.toThrowError(/超过 20ms/)
    expect(closedCount).toBe(1)

    // 重建后的新通道必须在本次请求前收到回放的注册，否则调用方得手动重注册
    await expect(sandbox.evaluate('boom()', {})).resolves.toBe('boom')
    expect(instances).toBe(2)
  })

  it('postMessage 抛错报 scope-not-serializable 且不杀通道', async () => {
    let closeCalls = 0
    const sandbox = createExpressionSandbox({
      createTransport: () => ({
        postMessage: () => {
          throw new TypeError('DataCloneError: fn could not be cloned')
        },
        close: () => {
          closeCalls += 1
        },
        onMessage: () => () => {},
      }),
    })

    await expect(sandbox.evaluate('1', { fn: () => 1 })).rejects.toThrowError(/无法送入沙箱/)
    // 消息根本没进通道，没有理由把 worker 一起杀掉
    expect(closeCalls).toBe(0)
  })

  it('协议版本不符时以 transport 错误失败并丢弃通道', async () => {
    let respond: ((message: unknown) => void) | null = null
    let closed = false
    const sandbox = createExpressionSandbox({
      createTransport: () => ({
        postMessage: (message) => {
          const id = (message as SandboxRequest).id
          queueMicrotask(() =>
            respond?.({ protocol: 999, kind: 'result', id, value: '不该被接受' }),
          )
        },
        close: () => {
          closed = true
        },
        onMessage: (handler) => {
          respond = handler
          return () => {}
        },
      }),
    })

    await expect(sandbox.evaluate('1', {})).rejects.toThrowError(/协议版本不符/)
    expect(closed).toBe(true)
  })

  it('dispose 后未决请求以 terminated 失败，新请求直接被拒', async () => {
    const closeSpy = vi.fn()
    const sandbox = createExpressionSandbox({
      createTransport: () => ({
        postMessage: () => {},
        close: closeSpy,
        onMessage: () => () => {},
      }),
    })

    const inflight = sandbox.evaluate('1 + 1', {})
    sandbox.dispose()

    await expect(inflight).rejects.toBeInstanceOf(SandboxTransportError)
    const rejected = await sandbox.evaluate('1', {}).catch((error: unknown) => error)
    expect((rejected as { code: string }).code).toBe('terminated')
    expect(closeSpy).toHaveBeenCalled()
  })
})

describe('沙箱的状态边界', () => {
  it('主线程引擎里的注册与编译缓存不会出现在沙箱一侧', async () => {
    const local = createExpressionEngine()
    local.functions.register({ name: 'onlyLocal', body: "'local'" })
    expect(local.evaluate('onlyLocal()', {})).toBe('local')

    const pair = createLoopback()
    const sandbox = createExpressionSandbox({ createTransport: () => pair.transport })

    // 沙箱是另一个引擎实例（在浏览器里是另一个线程）：注册不跨边界，
    // 需要它在沙箱里可用必须走 registerFunctions 送纯 JSON 声明
    await expect(sandbox.evaluate('onlyLocal()', {})).resolves.toBeUndefined()
    await expect(sandbox.evaluate('1 + 1', {})).resolves.toBe(2)
  })
})
