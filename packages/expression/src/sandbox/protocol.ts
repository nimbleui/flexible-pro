import type { ExpressionErrorKind } from '../errors'
import type { ExpressionScope, FunctionScopeLevel, FunctionSchema } from '@lc/schema'

/**
 * 沙箱求值的消息协议。
 *
 * 线上只传**表达式文本**与纯数据作用域，不传语法树：引擎侧有按文本的编译缓存，
 * 把 AST 序列化过界等于把缓存搬到两端、还要维护一份树的中立表示。
 * `@lc/schema` 里的 `ExpressionAst` 因此不需要成为可序列化类型。
 *
 * 同样不传函数：`FunctionSchema` 是纯 JSON 声明，可以过界；宿主注入的 JS 函数不能，
 * 这是沙箱的能力边界而不是实现缺陷（见 `SandboxFailure` 的 `scope-not-serializable`）。
 */

/** 协议版本；worker 侧与 client 侧不一致时立即失败，不做兼容猜测 */
export const SANDBOX_PROTOCOL_VERSION = 1

/** 沙箱支持的求值操作，与同步 `ExpressionEngine` 的三个入口一一对应 */
export type SandboxOperation = 'evaluate' | 'interpolate' | 'resolveValue'

/** 错误载荷；类实例不能跨 realm，客户端按此重建 `ExpressionError` */
export interface SandboxErrorPayload {
  readonly kind: ExpressionErrorKind
  readonly message: string
  readonly expression: string
  readonly offset?: number
}

/**
 * 发往 worker 的请求。
 *
 * `input` 用 `unknown` 而不是 `string`：`resolveValue` 的入参是一段任意 schema 值
 * （对象、数组、`ExpressionString` 都行），把它塞进 `source: string` 会让协议
 * 假装自己只处理字符串，而调用方迟早要传配置块。
 */
export type SandboxRequest =
  | {
      readonly protocol: number
      readonly kind: 'invoke'
      readonly id: number
      readonly operation: SandboxOperation
      readonly input: unknown
      readonly scope: ExpressionScope
    }
  | {
      readonly protocol: number
      readonly kind: 'register'
      readonly id: number
      readonly registrationId: number
      readonly functions: readonly FunctionSchema[]
      readonly level: FunctionScopeLevel
    }
  | {
      readonly protocol: number
      readonly kind: 'unregister'
      readonly id: number
      readonly registrationId: number
    }
  | {
      readonly protocol: number
      readonly kind: 'register'
      readonly id: number
      readonly registrationId: number
      readonly functions: readonly FunctionSchema[]
      readonly level: FunctionScopeLevel
    }
  | {
      readonly protocol: number
      readonly kind: 'unregister'
      readonly id: number
      readonly registrationId: number
    }

/** 注册成功的回执载荷；`rejected` 是名字非法或与内置重名的函数 */
export interface SandboxRegistrationResult {
  readonly registered: readonly string[]
  readonly rejected: readonly string[]
}

/** worker 回传的响应 */
export type SandboxResponse =
  | {
      readonly protocol: number
      readonly kind: 'result'
      readonly id: number
      readonly value: unknown
      /** 本次请求内被求值器吞掉并降级的那些诊断；同步引擎里由 `onDiagnostic` 承担同一职责 */
      readonly diagnostics?: readonly SandboxErrorPayload[]
    }
  | {
      readonly protocol: number
      readonly kind: 'failure'
      readonly id: number
      readonly error: SandboxErrorPayload
      /**
       * 失败响应同样必须带上已收集的诊断：一条表达式常常先在作用域上留下警告
       * （未绑定名字），再在下一跳抛错。只回传 `error` 会把前半段证据丢掉。
       */
      readonly diagnostics?: readonly SandboxErrorPayload[]
    }

/**
 * 沙箱侧独有的一类失败不在此列：作用域无法克隆、协议版本不符、worker 被终止——
 * 那些是**通道**的问题而不是表达式的问题，混进 `ExpressionErrorKind` 会把排查方向
 * 误导到语法上，因此由客户端抛出独立的 `SandboxTransportError`（见 `client.ts`）。
 */

/** 判断未知消息是否为沙箱响应 */
export function isSandboxResponse(value: unknown): value is SandboxResponse {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SandboxResponse>
  return (
    (candidate.kind === 'result' || candidate.kind === 'failure') &&
    typeof candidate.id === 'number'
  )
}
