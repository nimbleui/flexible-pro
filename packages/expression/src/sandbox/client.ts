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
  /** 投递一条协议消息；克隆失败应同步抛出（客户端按 DataCloneError 归类） */
  postMessage(message: unknown): void
  /** 终止通道；调用后不得再有消息回调进入客户端 */
  close(): void
  /** 订阅消息；返回取消订阅句柄 */
  onMessage(handler: (message: unknown) => void): () => void
}

/**
 * 通道工厂。
 *
 * 每次调用必须产出全新通道（新 Worker/Port），因为超时与协议不符都会终止
 * 旧通道并依赖工厂重建；工厂需保持可重复调用、无内部缓存。
 */
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
  /** 沙箱内注册成功的函数名，顺序与入参声明一致 */
  readonly registered: readonly string[]
  /** 被沙箱拒绝的名字（非法名或与内置重名）；不影响其余条目生效 */
  readonly rejected: readonly string[]
  /** 注销沙箱里的这批函数；通道已失效时静默完成 */
  dispose(): Promise<void>
}

/**
 * 沙箱求值客户端。
 *
 * 三个求值方法与同步 `ExpressionEngine` 同名同义，只是全部返回 Promise：
 * 作用域经结构化克隆过界，函数、类实例等不可克隆值会导致整个请求失败。
 * 生命周期：通道惰性建立；超时或协议不符自动终止并重建，重建时回放函数注册。
 */
export interface ExpressionSandbox {
  /** 求值白名单表达式；表达式错误以 `ExpressionError` reject */
  evaluate(source: string, scope: ExpressionScope): Promise<unknown>
  /** 插值混排模板；与同步入口一致，结果恒为字符串 */
  interpolate(template: string, scope: ExpressionScope): Promise<string>
  /** 递归解析 schema 值中的表达式；不可克隆的子树按通道错误失败 */
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

/**
 * 沙箱客户端配置。
 *
 * 除通道工厂外全部可缺省；超时与诊断语义对齐同步引擎，调用方可以在
 * 沙箱 / 同步两种实现间无痛切换。
 */
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

/** 一条在途请求的结算手段与超时定时器；收到响应或通道销毁时二者必须同时摘除 */
interface Pending {
  /** 成功结算；value 是跨 realm 的纯数据响应 */
  resolve(value: unknown): void
  /** 失败结算；错误类型可能是 ExpressionError（表达式）或 SandboxTransportError（通道） */
  reject(error: unknown): void
  /** 超时定时器；响应到达后必须 clearTimeout，防止误杀后续请求 */
  timer: ReturnType<typeof setTimeout>
}

/** 客户端侧保留的一条注册意图；通道重建后按插入顺序回放，同名覆盖关系得以保持 */
interface DeclaredRegistration {
  /** 原始声明列表；回放时原样重发，不做二次加工 */
  readonly fns: readonly FunctionSchema[]
  /** 注册层级；随声明一起回放，保持覆盖顺序 */
  readonly level: FunctionScopeLevel
}

/** 求值请求形态；operation 与 input 类型的一致性由 worker 侧校验 */
type InvokeRequest = Extract<SandboxRequest, { kind: 'invoke' }>

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
  const declared = new Map<number, DeclaredRegistration>()

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

  /** 把响应携带的诊断逐条换算成主线程错误对象并上报；与同步引擎的 onDiagnostic 同语义 */
  function notifyDiagnostics(diagnostics: readonly SandboxErrorPayload[] | undefined): void {
    for (const diagnostic of diagnostics ?? []) {
      options.onDiagnostic?.(reviveError(diagnostic), {
        scope: 'expression',
        origin: 'sandbox',
        expression: diagnostic.expression,
      })
    }
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

    notifyDiagnostics(response.diagnostics)

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
