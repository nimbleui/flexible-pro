import { serveSandboxOnPort } from '@lc/expression'

/**
 * 表达式沙箱的 worker 入口。
 *
 * 文件本体只做接线：求值、白名单规则与函数注册表全在 `@lc/expression` 里，
 * 因此 worker 与主线程跑的是同一份语言实现，不存在「沙箱里是另一个解释器」的漂移。
 *
 * 启用方式（当前设计器**未默认启用**，因为没有调用方就不该多起一个线程）：
 * 消费方用 `createExpressionSandbox({ createTransport })` 惰性建通道，
 * 传输适配器见 `createWorkerTransport`。`new URL(..., import.meta.url)` 必须写在
 * 构造点上，Vite 才能静态分析出这个 worker 资源。
 */
serveSandboxOnPort(self)
