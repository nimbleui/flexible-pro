import type { ExpressionEngine, FunctionRegistration } from '@lc/schema'
import type { ExpressionError } from '../errors'
import { isExpressionError } from '../errors'
import type { ExpressionEngineOptions } from '../engine'
import { createExpressionEngine } from '../engine'
import type {
  SandboxErrorPayload,
  SandboxRegistrationResult,
  SandboxRequest,
  SandboxResponse,
} from './protocol'
import { SANDBOX_PROTOCOL_VERSION } from './protocol'

/**
 * worker 侧的消息处理器。
 *
 * 刻意做成**纯函数式**（输入一条请求、输出一条响应），不引用 `self` /
 * `DedicatedWorkerGlobalScope` / `onmessage`：核心包因此保持环境无关，
 * 真实的 worker 入口只剩 5 行接线（放在装配层），而协议本身可以直接在单测里驱动。
 *
 * 每次 `handle` 都是同步完成的，所以「一个请求对应一个诊断桶」不需要队列——
 * worker 的消息循环不会在两次 handle 之间插入另一条消息的处理。
 */

/** 沙箱端点：内部持有一个引擎实例，对外只有一个消息处理函数 */
export interface SandboxEndpoint {
  /** 处理一条请求；消息形状非法时返回 null（不猜调用方想做什么） */
  handle(message: unknown): SandboxResponse | null
  /** 暴露引擎，供入口做额外的注册或调参；调用方不应跨请求持有它的编译缓存 */
  readonly engine: ExpressionEngine
}

function toPayload(error: unknown): SandboxErrorPayload {
  if (isExpressionError(error)) {
    const expressionError = error as ExpressionError
    return {
      kind: expressionError.kind,
      message: expressionError.message,
      expression: expressionError.expression,
      offset: expressionError.offset,
    }
  }
  return {
    kind: 'internal',
    message: error instanceof Error ? error.message : String(error),
    expression: '',
  }
}

function isRequest(value: unknown): value is SandboxRequest {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.protocol === SANDBOX_PROTOCOL_VERSION &&
    typeof candidate.id === 'number' &&
    (candidate.kind === 'invoke' ||
      candidate.kind === 'register' ||
      candidate.kind === 'unregister')
  )
}

/**
 * 创建沙箱端点。
 *
 * @param engineOptions 引擎预算配置；worker 内的时间预算与主线程那条是两份独立额度
 */
export function createSandboxEndpoint(
  engineOptions: ExpressionEngineOptions = {},
): SandboxEndpoint {
  const registrations = new Map<number, FunctionRegistration[]>()
  let diagnostics: SandboxErrorPayload[] = []

  const engine = createExpressionEngine({
    ...engineOptions,
    // 同步引擎的策略是「吞掉异常 + 上报诊断」；沙箱里诊断没有去处，
    // 所以先收集到当前请求的桶里，随响应一起回传，保证可观测性与主线程等价
    onDiagnostic: (error) => {
      diagnostics.push(toPayload(error))
    },
  })

  function fail(id: number, error: unknown): SandboxResponse {
    return {
      protocol: SANDBOX_PROTOCOL_VERSION,
      kind: 'failure',
      id,
      error: toPayload(error),
      diagnostics,
    }
  }

  function ok(id: number, value: unknown): SandboxResponse {
    return { protocol: SANDBOX_PROTOCOL_VERSION, kind: 'result', id, value, diagnostics }
  }

  function invoke(request: Extract<SandboxRequest, { kind: 'invoke' }>): SandboxResponse {
    const { operation, input, scope } = request

    // 三个求值入口内部都不抛错（吞异常 + 记诊断），这里兜的是作用域里
    // getter 之类的意外异常，它不属于表达式失败
    if (operation === 'evaluate') {
      if (typeof input !== 'string')
        return fail(request.id, new TypeError('evaluate 的入参必须是字符串'))
      return ok(request.id, engine.evaluate(input, scope))
    }

    if (operation === 'interpolate') {
      if (typeof input !== 'string') {
        return fail(request.id, new TypeError('interpolate 的入参必须是字符串'))
      }
      return ok(request.id, engine.interpolate(input, scope))
    }

    return ok(request.id, engine.resolveValue(input, scope))
  }

  function register(request: Extract<SandboxRequest, { kind: 'register' }>): SandboxResponse {
    const registered: string[] = []
    const rejected: string[] = []
    const bucket = registrations.get(request.registrationId) ?? []

    for (const schema of request.functions) {
      const before = diagnostics.length
      const handle = engine.functions.register(schema, request.level)

      // 注册失败不抛错、只产生诊断：据此区分接受与拒绝，比另造一套返回值语义更省
      if (diagnostics.length > before) {
        rejected.push(schema.name)
        continue
      }

      registered.push(schema.name)
      bucket.push(handle)
    }

    if (bucket.length > 0) registrations.set(request.registrationId, bucket)

    const result: SandboxRegistrationResult = { registered, rejected }
    return ok(request.id, result)
  }

  function unregister(
    request: Extract<SandboxRequest, { kind: 'unregister' }>,
  ): SandboxResponse {
    const bucket = registrations.get(request.registrationId)
    if (bucket) {
      for (const handle of bucket) handle.dispose()
      registrations.delete(request.registrationId)
    }
    return ok(request.id, true)
  }

  return {
    engine,
    handle(message: unknown): SandboxResponse | null {
      if (!isRequest(message)) return null

      diagnostics = []

      try {
        if (message.kind === 'invoke') return invoke(message)
        if (message.kind === 'register') return register(message)
        return unregister(message)
      } catch (error) {
        return fail(message.id, error)
      }
    },
  }
}

/** worker 端口的最小形态；浏览器 worker 全局天然满足，单测可以传假端口 */
export interface SandboxPort {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

/**
 * 把端点接到 worker 端口上。
 *
 * 参数是结构类型而不是 `DedicatedWorkerGlobalScope`：本仓 `tsconfig.base.json:6` 的
 * `lib` 只有 `ES2022 / DOM / DOM.Iterable`，没有 `WebWorker`，直接写 worker 全局类型
 * 会 TS2304；而 DOM 与 WebWorker 两个 lib 同时启用会在 `self` 等成员上冲突。
 * 因此核心包不引用任何环境全局，应用侧入口只需 `serveSandboxOnPort(self)`。
 *
 * @returns 解除接线的函数
 */
export function serveSandboxOnPort(
  port: SandboxPort,
  options: ExpressionEngineOptions = {},
): () => void {
  const endpoint = createSandboxEndpoint(options)
  const listener = (event: { data: unknown }): void => {
    const response = endpoint.handle(event.data)
    if (response) port.postMessage(response)
  }

  port.addEventListener('message', listener)
  return () => port.removeEventListener('message', listener)
}
