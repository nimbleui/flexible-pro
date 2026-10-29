import type { Disposable } from './types'

function reportError(error: unknown): void {
  console.error('[lc] effect 回收失败', error)
}

/**
 * 逆序回收副作用。
 *
 * 规则：
 * - 后注册先释放，符合「依赖方先于被依赖方销毁」；
 * - 关闭后再注册的副作用立即回收，避免异步 apply 在卸载后泄漏；
 * - `effect()` 在关闭后不再执行 factory，避免卸载后发起请求/定时器。
 */
export class EffectScope {
  private items: Disposable[] = []

  private closed = false

  /** 是否已关闭；关闭后所有新增副作用都会被立即回收。 */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * 登记一个已经创建好的副作用。
   *
   * @param dispose 回收函数；抛错会被捕获上报，不阻断后续回收。
   */
  add(dispose: () => void): Disposable {
    const item: Disposable = { dispose }
    if (this.closed) {
      item.dispose()
      return item
    }
    this.items.push(item)
    return item
  }

  /**
   * 延迟创建并登记副作用。
   *
   * @param factory 创建副作用；作用域已关闭时不会执行。
   */
  effect<T extends Disposable>(factory: () => T): T {
    if (this.closed) {
      return { dispose() {} } as T
    }
    const item = factory()
    if (this.closed) {
      item.dispose()
      return item
    }
    this.items.push(item)
    return item
  }

  /** 逆序释放全部副作用；幂等。 */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      try {
        this.items[index]?.dispose()
      } catch (error) {
        reportError(error)
      }
    }
    this.items.length = 0
  }
}
