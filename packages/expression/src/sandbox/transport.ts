import type { SandboxTransport } from './client'

/**
 * 浏览器 Worker → `SandboxTransport` 适配。
 *
 * 这一处是沙箱里唯一引用 DOM 类型的地方，且只用在类型上：函数体只调
 * `postMessage` / `addEventListener` / `terminate` 三个方法，不用 worker 全局对象。
 * 因此不消费沙箱的宿主（设计器主线程、无 DOM 的运行时播放器）不会被拖进任何依赖，
 * 未被引用的导出在构建期即被摇掉。
 *
 * 之所以不做成「直接接受 URL 并自己 new Worker」：`new Worker(new URL('./x.worker.ts', import.meta.url))`
 * 里的 `new URL(...)` 必须由 Vite 静态分析才能产出 worker 资源，字符串 URL 一进函数就失去了可分析性。
 * worker 的构造点因此必须留在调用方那一行。
 */
export function createWorkerTransport(worker: Worker): SandboxTransport {
  return {
    postMessage: (message) => worker.postMessage(message),
    close: () => worker.terminate(),
    onMessage: (handler) => {
      const listener = (event: MessageEvent): void => {
        handler(event.data)
      }
      worker.addEventListener('message', listener)
      return () => worker.removeEventListener('message', listener)
    },
  }
}
