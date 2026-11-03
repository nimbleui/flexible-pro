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
  /** 错误类别；与同步引擎 `ExpressionError.kind` 同一白名单，客户端按它分支重建 */
  readonly kind: ExpressionErrorKind
  /** 面向用户的中文文案；原样透传，客户端不再二次解析 */
  readonly message: string
  /** 出错所在表达式的原文；嵌套调用或模板插值时可能与顶层表达式不同 */
  readonly expression: string
  /**
   * 错误在 `expression` 内的起点；单位是 UTF-16 代码单元，与编辑器及
   * `Token.start` 同一坐标空间。缺省表示无定位信息（运行期错误通常没有）。
   */
  readonly offset?: number
}

/**
 * 发往 worker 的请求。
 *
 * `input` 用 `unknown` 而不是 `string`：`resolveValue` 的入参是一段任意 schema 值
 * （对象、数组、`ExpressionString` 都行），把它塞进 `source: string` 会让协议
 * 假装自己只处理字符串，而调用方迟早要传配置块。
 *
 * 公共字段约束（三种请求形态一致）：
 * - `protocol` 恒为 `SANDBOX_PROTOCOL_VERSION`，worker 侧不符立即拒绝；
 * - `id` 是客户端单调递增的请求序号，只用于响应关联，无去重语义；
 * - `registrationId` 是注册批次号，通道重建后回放时保持不变。
 */
export type SandboxRequest =
  /** 一次求值请求 */
  | {
      /** 协议版本号 */
      readonly protocol: number
      /** 判别字段：求值 */
      readonly kind: 'invoke'
      readonly id: number
      /** 求值入口，与同步 `ExpressionEngine` 的三个方法一一对应 */
      readonly operation: SandboxOperation
      /** 入口入参：`evaluate` / `interpolate` 传字符串，`resolveValue` 传任意 schema 值 */
      readonly input: unknown
      /** 纯数据作用域；必须可结构化克隆，否则客户端以 `scope-not-serializable` 失败 */
      readonly scope: ExpressionScope
    }
  /** 批量注册声明式函数 */
  | {
      readonly protocol: number
      /** 判别字段：注册 */
      readonly kind: 'register'
      readonly id: number
      readonly registrationId: number
      /** 待注册的纯 JSON 函数声明；JS 实现无法过界，不属于协议能力 */
      readonly functions: readonly FunctionSchema[]
      /** 作用域层级；决定 worker 内同名函数的覆盖顺序 */
      readonly level: FunctionScopeLevel
    }
  /** 注销一批函数；worker 侧按批次号 dispose，批次不存在时静默成功 */
  | {
      readonly protocol: number
      /** 判别字段：注销 */
      readonly kind: 'unregister'
      readonly id: number
      readonly registrationId: number
    }

/** 注册成功的回执载荷；`rejected` 是名字非法或与内置重名的函数 */
export interface SandboxRegistrationResult {
  /** 成功进入注册表的名字，保持与 `functions` 入参相同的相对顺序 */
  readonly registered: readonly string[]
  /** 注册阶段被拒绝的名字；未注册也不求值，调用方据此提示用户 */
  readonly rejected: readonly string[]
}

/** worker 回传的响应 */
export type SandboxResponse =
  /** 求值或注册成功 */
  | {
      /** 协议版本号；客户端必须在摘除待办前校验，不符即断开重建 */
      readonly protocol: number
      /** 判别字段：成功 */
      readonly kind: 'result'
      /** 关联的请求 `id`；客户端据此结算对应的待办 Promise */
      readonly id: number
      /** 求值结果；跨 realm 的纯数据，箭头函数等中间形态不可能出现在这里 */
      readonly value: unknown
      /** 本次请求内被求值器吞掉并降级的那些诊断；同步引擎里由 `onDiagnostic` 承担同一职责 */
      readonly diagnostics?: readonly SandboxErrorPayload[]
    }
  /** 表达式层面的失败；通道层错误不走这条，见 `SandboxTransportError` */
  | {
      readonly protocol: number
      /** 判别字段：失败 */
      readonly kind: 'failure'
      readonly id: number
      /** 表达式错误载荷；客户端重建为 `ExpressionError` 后 reject */
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
