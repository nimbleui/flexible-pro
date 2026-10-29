import type { Disposable, EventOptions } from './types'

/**
 * 运行时监听器类型。
 *
 * 参数声明为 `never[]`：任何具体签名的监听器都可赋值给它，
 * 调用时由内核统一转成 `unknown[]`。类型安全由 `Context.on` 的
 * `Events` 表在出入口保证，这里仅为存储层。
 */
export type Listener = (...args: never[]) => unknown

interface ListenerEntry {
  listener: Listener
  options: EventOptions
}

function reportError(error: unknown): void {
  console.error('[lc] 事件监听器执行失败', error)
}

/**
 * 把存储层监听器还原成可调用签名。
 *
 * 存储时参数被声明为 `never[]` 以接受任意具体签名；调用点统一在这里
 * 转成 `unknown[]`，避免在每种分发模式里重复断言。
 */
function invoke(listener: Listener): (...args: unknown[]) => unknown {
  return listener as (...args: unknown[]) => unknown
}

/**
 * 类型化事件总线，支持 5 种分发模式。
 *
 * - `emit`：同步广播，错误隔离
 * - `parallel`：全部执行并等待全部完成
 * - `serial`：顺序执行
 * - `bail`：顺序执行，第一个非 undefined 的结果生效
 * - `waterfall`：前一个监听器的返回值作为下一个的输入
 */
export class EventBus {
  private listeners = new Map<string, ListenerEntry[]>()

  /**
   * 注册监听器。
   *
   * 类型化入口是 `Context.on`；本方法不校验事件名，供 Context 与内核内部总线共用。
   *
   * @param options `prepend` 优先于 `priority`；同类按 priority 从高到低排序。
   */
  add(name: string, listener: Listener, options: EventOptions = {}): Disposable {
    const entry: ListenerEntry = { listener, options }
    const list = this.listeners.get(name)

    if (list) {
      list.push(entry)
      list.sort(compareListeners)
    } else {
      this.listeners.set(name, [entry])
    }

    return {
      dispose: () => {
        const current = this.listeners.get(name)
        if (!current) return
        const index = current.indexOf(entry)
        if (index >= 0) current.splice(index, 1)
        if (current.length === 0) this.listeners.delete(name)
      },
    }
  }

  /** 同步广播；单个监听器抛错不会中断其余监听器。 */
  emit(name: string, ...args: unknown[]): void {
    for (const { listener } of this.snapshot(name)) {
      try {
        invoke(listener)(...args)
      } catch (error) {
        reportError(error)
      }
    }
  }

  /** 并行执行全部监听器，等待全部完成；错误逐个上报但不 reject。 */
  async parallel(name: string, ...args: unknown[]): Promise<void> {
    await Promise.all(
      this.snapshot(name).map(async ({ listener }) => {
        try {
          await invoke(listener)(...args)
        } catch (error) {
          reportError(error)
        }
      }),
    )
  }

  /** 顺序执行监听器；单个失败不阻断后续（与 emit 一致），除非监听器自行抛出中断。 */
  async serial(name: string, ...args: unknown[]): Promise<void> {
    for (const { listener } of this.snapshot(name)) {
      try {
        await invoke(listener)(...args)
      } catch (error) {
        reportError(error)
      }
    }
  }

  /** 顺序执行，返回第一个非 undefined 的结果；常用于画布 drop、快捷键处理。 */
  async bail<T>(name: string, ...args: unknown[]): Promise<T | undefined> {
    for (const { listener } of this.snapshot(name)) {
      let result: unknown
      try {
        result = await invoke(listener)(...args)
      } catch (error) {
        reportError(error)
        continue
      }
      if (result !== undefined) return result as T
    }
    return undefined
  }

  /** 管线式执行：前一个监听器的返回值作为下一个的输入。 */
  async waterfall<T>(name: string, input: T, ...args: unknown[]): Promise<T> {
    let value = input
    for (const { listener } of this.snapshot(name)) {
      value = (await invoke(listener)(value, ...args)) as T
    }
    return value
  }

  private snapshot(name: string): readonly ListenerEntry[] {
    return [...(this.listeners.get(name) ?? [])]
  }
}

function compareListeners(a: ListenerEntry, b: ListenerEntry): number {
  const prependDiff = Number(Boolean(b.options.prepend)) - Number(Boolean(a.options.prepend))
  if (prependDiff !== 0) return prependDiff
  return (b.options.priority ?? 0) - (a.options.priority ?? 0)
}
