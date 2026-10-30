import type { ExpressionScope, FunctionScopeLevel, FunctionSchema } from '@lc/schema'
import { ExpressionError } from '../errors'
import type {
  SandboxErrorPayload,
  SandboxRegistrationResult,
  SandboxRequest,
  SandboxResponse,
} from './protocol'
import { SANDBOX_PROTOCOL_VERSION, isSandboxResponse } from './protocol'

/**
 * 沙箱客户端：把同步 `ExpressionEngine` 的三个求值入口映射成 Promise。
 *
 * 不直接依赖 `Worker` / `MessagePort` 类型，而是依赖一个三方法的
 * `SandboxTransport` 结构化接口。理由有两个：核心包要保持环境无关
 * （`@lc/expression` 现在不引用任何浏览器全局），以及协议可以在单测里被直接驱动。
 *
 * **超时是真能中止的，这是沙箱相对同 realm 的唯一实质收益。**
 * 主线程里的时间预算只能在一次原生调用返回后收尾；worker 里可以直接 `close()` 掉
 * 正在跑的那个线程（设计文档 §19.4「超时、内存上限、超限终止并上报」）。
 */

/** 传输通道的最小接口；浏览器 Worker 与 Node worker_threads 都能适配 */
export interface SandboxTransport {
  postMessage(message: unknown): void
  close(): void
  /** 订阅消息；返回取消订阅句柄 */
  onMessage(handler: (message: unknown) => void): () => void
}

export type SandboxTransportFactory = () => SandboxTransport

/** 通道层错误码；与 `ExpressionErrorKind` 分开，因为不是表达式本身的问题 */
export type SandboxTransportErrorCode =
  'scope-not-serializable' | 'protocol-mismatch' | 'timeout' | 'terminated'

/** 通道层错误：数据不能过界、worker 被终止、版本不符、请求超时 */
export class SandboxTransportError extends Error {
  readonly code: SandboxTransportErrorCode

  constructor(code: SandboxTransportErrorCode, message: string) {
    super(message)
    this.name = 'SandboxTransportError'
    this.code = code
  }
}

/** 一次沙箱内的函数注册；`rejected` 让调用方知道哪些声明没进去，不必翻诊断 */
export interface SandboxFunctionRegistration {
  readonly registered: readonly string[]
  readonly rejected: readonly string[]
  /** 注销沙箱里的这批函数；通道已失效时静默完成 */
  dispose(): Promise<void>
}

export interface ExpressionSandbox {
  evaluate(source: string, scope: ExpressionScope): Promise<unknown>
  interpolate(template: string, scope: ExpressionScope): Promise<string>
  resolveValue(value: unknown, scope: ExpressionScope): Promise<unknown>
  /**
   * 把 `FunctionSchema` 声明送进沙箱。
   *
   * 只能是纯 JSON 声明：宿主注入的 JS 函数无法结构化克隆，
   * 这类表达式在沙箱里会以 `unknown-function` 失败 —— 需要它们时应当留在主 realm 求值。
   */
  registerFunctions(
    fns: readonly FunctionSchema[],
    level?: FunctionScopeLevel,
  ): Promise<SandboxFunctionRegistration>
  /** 关闭通道；未完成的请求以 `terminated` 失败 */
  dispose(): void
}

export interface ExpressionSandboxOptions {
  /**
   * 创建（必要时重建）传输通道。
   *
   * 必须是**可重复调用**的工厂而不是现成实例：超时终止后客户端要用同一套配置
   * 拉起一个新的 worker，并回放此前的函数注册。
   */
  createTransport: SandboxTransportFactory
  /**
   * 单次请求的等待上限（毫秒）@default 1000。
   * 触发即终止通道并重建；worker 内另有自己的求值预算，两者互不替代。
   */
  timeoutMs?: number
  /** 沙箱内被吞掉的诊断回传；与同步引擎的 `onDiagnostic` 同一语义 */
  onDiagnostic?: (error: unknown, detail: Record<string, unknown>) => void
}

interface Pending {
  resolve(value: unknown): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 1000

/** 跨 realm 过来的是普通对象；按载荷重建错误，保留 kind 供调用方分支 */
function reviveError(payload: SandboxErrorPayload): ExpressionError {
  return new ExpressionError(payload.kind, payload.message, payload.expression, payload.offset)
}

/**
 * 创建沙箱客户端。
 *
 * @param options 通道工厂、超时与诊断回调
 */
export function createExpressionSandbox(options: ExpressionSandboxOptions): ExpressionSandbox {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let transport: SandboxTransport | null = null
  let unsubscribe: (() => void) | null = null
  let seq = 0
  let registrationSeq = 0
  let disposed = false

  const pending = new Map<number, Pending>()
  /** 客户端侧保留的注册意图；通道重建后按插入顺序回放，同名覆盖关系得以保持 */
  const declared = new Map<
    number,
    { fns: readonly FunctionSchema[]; level: FunctionScopeLevel }
  >()

  function ensureTransport(): SandboxTransport {
    if (transport) return transport

    const created = options.createTransport()
    unsubscribe = created.onMessage(handleMessage)
    transport = created
    replayRegistrations()
    return created
  }

  /** 丢弃当前通道；正在排队的请求以 `reason` 失败 */
  function dropTransport(reason: SandboxTransportErrorCode, message: string): void {
    unsubscribe?.()
    unsubscribe = null
    transport?.close()
    transport = null

    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new SandboxTransportError(reason, message))
    }
    pending.clear()
  }

  function handleMessage(message: unknown): void {
    if (!isSandboxResponse(message)) return
    const response = message as SandboxResponse

    // 版本判定必须在摘除待办之前：否则这条响应的发起者既不 resolve 也不 reject，
    // 调用方的 Promise 会永久挂住
    if (response.protocol !== SANDBOX_PROTOCOL_VERSION) {
      dropTransport(
        'protocol-mismatch',
        `沙箱协议版本不符：期望 ${SANDBOX_PROTOCOL_VERSION}，收到 ${response.protocol}`,
      )
      return
    }

    const entry = pending.get(response.id)
    if (!entry) return

    pending.delete(response.id)
    clearTimeout(entry.timer)

    for (const diagnostic of response.diagnostics ?? []) {
      options.onDiagnostic?.(reviveError(diagnostic), {
        scope: 'expression',
        origin: 'sandbox',
        expression: diagnostic.expression,
      })
    }

    if (response.kind === 'failure') {
      entry.reject(reviveError(response.error))
      return
    }
    entry.resolve(response.value)
  }

  function send<T>(build: (id: number) => SandboxRequest): Promise<T> {
    if (disposed) return Promise.reject(new SandboxTransportError('terminated', '沙箱已关闭'))

    const id = ++seq
    const request = build(id)

    return new Promise<T>((resolve, reject) => {
      // 先登记再发送：postMessage 可能同步抛（DataCloneError），那时要把这条待办撤掉
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(
          new SandboxTransportError('timeout', `沙箱求值超过 ${timeoutMs}ms，已终止该 worker`),
        )
        // 唯一能把正在执行的代码停下来的手段；同 realm 的时间预算做不到这一点
        dropTransport('timeout', '沙箱因超时被终止')
      }, timeoutMs)

      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })

      try {
        ensureTransport().postMessage(request)
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(
          new SandboxTransportError(
            'scope-not-serializable',
            `入参无法送入沙箱（多半是作用域里含函数、类实例或 DOM 节点）：${String(
              (error as Error)?.message ?? error,
            )}`,
          ),
        )
      }
    })
  }

  function replayRegistrations(): void {
    for (const [registrationId, entry] of declared) {
      const replay: SandboxRequest = {
        protocol: SANDBOX_PROTOCOL_VERSION,
        kind: 'register',
        id: ++seq,
        registrationId,
        functions: entry.fns,
        level: entry.level,
      }
      transport?.postMessage(replay)
    }
  }

  type InvokeRequest = Extract<SandboxRequest, { kind: 'invoke' }>

  function invoke<T>(
    operation: InvokeRequest['operation'],
    input: InvokeRequest['input'],
    scope: ExpressionScope,
  ): Promise<T> {
    return send<T>((id) => ({
      protocol: SANDBOX_PROTOCOL_VERSION,
      kind: 'invoke',
      id,
      operation,
      input,
      scope,
    }))
  }

  return {
    evaluate: (source, scope) => invoke<unknown>('evaluate', source, scope),
    interpolate: (template, scope) => invoke<string>('interpolate', template, scope),
    resolveValue: (value, scope) => invoke<unknown>('resolveValue', value, scope),

    registerFunctions: async (fns, level = 'page') => {
      const registrationId = ++registrationSeq
      declared.set(registrationId, { fns, level })

      let result: SandboxRegistrationResult

      try {
        result = await send<SandboxRegistrationResult>((id) => ({
          protocol: SANDBOX_PROTOCOL_VERSION,
          kind: 'register',
          id,
          registrationId,
          functions: fns,
          level,
        }))
      } catch (error) {
        // 通道层面的失败要回滚注册意图，否则超时重建后会复活一批调用方认为没成功的函数
        declared.delete(registrationId)
        throw error
      }

      return {
        registered: result.registered,
        rejected: result.rejected,
        dispose: async () => {
          declared.delete(registrationId)
          if (!transport) return
          await send<boolean>((id) => ({
            protocol: SANDBOX_PROTOCOL_VERSION,
            kind: 'unregister',
            id,
            registrationId,
          })).catch(() => undefined)
        },
      }
    },

    dispose: () => {
      if (disposed) return
      disposed = true
      declared.clear()
      dropTransport('terminated', '沙箱已关闭')
    },
  }
}
