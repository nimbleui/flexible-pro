/**
 * 表达式引擎（`@lc/expression`）
 * ---
 * 白名单解释器的框架无关实现：词法、语法、求值、函数注册表与缓存。
 * 不依赖 Vue、DOM 与插件内核，因此运行时播放器、FlowRunner 与设计器可以共用同一份。
 *
 * 语言契约（语法树、`ExpressionEngine`、`FunctionRegistry`）全部在 `@lc/schema`，
 * 本包只实现它们，不重新定义它们。
 */

export type { ExpressionDiagnosticSink, ExpressionEngineOptions } from './engine'
export { createExpressionEngine } from './engine'

export type { ExpressionErrorKind } from './errors'
export { ExpressionError, isExpressionError } from './errors'

/**
 * 沙箱执行后端（可选旁路）。
 *
 * 同步求值入口不受影响：worker 不能服务于 computed 渲染路径，它的用途是把**不可信来源**
 * 的表达式求值移出主线程，并让超时可以真正中止（terminate），这是同 realm 做不到的。
 */
export type {
  SandboxErrorPayload,
  SandboxOperation,
  SandboxRegistrationResult,
  SandboxRequest,
  SandboxResponse,
} from './sandbox/protocol'
export { SANDBOX_PROTOCOL_VERSION } from './sandbox/protocol'

export type { SandboxEndpoint, SandboxPort } from './sandbox/dispatch'
export { createSandboxEndpoint, serveSandboxOnPort } from './sandbox/dispatch'

export type {
  ExpressionSandbox,
  ExpressionSandboxOptions,
  SandboxFunctionRegistration,
  SandboxTransport,
  SandboxTransportErrorCode,
  SandboxTransportFactory,
} from './sandbox/client'
export { createExpressionSandbox, SandboxTransportError } from './sandbox/client'
export { createWorkerTransport } from './sandbox/transport'
