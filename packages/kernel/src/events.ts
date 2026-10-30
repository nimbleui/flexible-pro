import type { Disposable, EventOptions, PluginRecord } from './types'

/**
 * 运行时监听器类型。
 *
 * 参数声明为 `never[]`：任何具体签名的监听器都可赋值给它，
 * 调用时由内核统一转成 `unknown[]`。类型安全由 `Context.on` 的
 * `Events` 表在出入口保证，这里仅为存储层。
 */
export type Listener = (...args: never[]) => unknown

/** 事件分发模式；与 EventBus 的 5 个入口一一对应。 */
export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'

/**
 * 一次监听器执行的观测记录。
 *
 * 只用于 devtools 事件日志：监视器拿不到返回值也改不了分发顺序，
 * 所以即使插件设法注册了监视器，也无法影响其他监听器。
 */
export interface EventDispatchRecord {
  /** 事件名 */
  name: string
  /** 触发本次执行的分发模式 */
  mode: DispatchMode
  /** 注册方插件实例 id；由 `Context.on` 注入，内核内部注册没有 */
  pluginId?: string
  /**
   * 监听器自身耗时（毫秒）。
   *
   * `emit` 不等返回值，因此只含同步部分；其余四种模式等到 Promise 落地。
   */
  duration: number
  /** 监听器抛错时的原始错误；除 `waterfall` 外其余监听器照常执行 */
  error?: unknown
  /** 本次分发的监听器总数；配合记录顺序可看出当前是第几个处理者 */
  listenerCount: number
}

/** 事件分发监视器。 */
export type EventMonitor = (record: EventDispatchRecord) => void

/** 监视器回调；省略 `error` 表示这次执行没有抛错。 */
type Tracker = (entry: ListenerEntry, duration: number, error?: unknown) => void

interface ListenerEntry {
  listener: Listener
  options: EventOptions
  /** 注册该监听器的插件实例；供 devtools 归属，内核分发不读它 */
  owner?: PluginRecord
}

function reportError(error: unknown): void {
  console.error('[lc] 事件监听器执行失败', error)
}

function reportMonitorError(error: unknown): void {
  console.error('[lc] 事件监视器执行失败', error)
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

  private monitors = new Set<EventMonitor>()

  /**
   * 注册监听器。
   *
   * 类型化入口是 `Context.on`；本方法不校验事件名，供 Context 与内核内部总线共用。
   *
   * @param options `prepend` 优先于 `priority`；同类按 priority 从高到低排序。
   * @param owner 注册方插件实例；只用于 devtools 归属展示，省略表示内核内部注册。
   */
  add(
    name: string,
    listener: Listener,
    options: EventOptions = {},
    owner?: PluginRecord,
  ): Disposable {
    const entry: ListenerEntry = { listener, options, owner }
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

  /**
   * 订阅事件分发观测；返回注销句柄。
   *
   * 没有监视器时分发路径不取时间戳，因此未开启 devtools 时没有额外开销。
   * 监视器自身抛错只记日志，不影响正在分发的监听器。
   */
  monitor(listener: EventMonitor): Disposable {
    this.monitors.add(listener)
    return { dispose: () => this.monitors.delete(listener) }
  }

  /** 同步广播；单个监听器抛错不会中断其余监听器。 */
  emit(name: string, ...args: unknown[]): void {
    const list = this.snapshot(name)
    const track = this.tracker(name, 'emit', list.length)

    for (const entry of list) {
      const startedAt = track ? performance.now() : 0
      try {
        invoke(entry.listener)(...args)
      } catch (error) {
        reportError(error)
        track?.(entry, performance.now() - startedAt, error)
        continue
      }
      track?.(entry, performance.now() - startedAt)
    }
  }

  /** 并行执行全部监听器，等待全部完成；错误逐个上报但不 reject。 */
  async parallel(name: string, ...args: unknown[]): Promise<void> {
    const list = this.snapshot(name)
    const track = this.tracker(name, 'parallel', list.length)

    await Promise.all(
      list.map(async (entry) => {
        const startedAt = track ? performance.now() : 0
        try {
          await invoke(entry.listener)(...args)
        } catch (error) {
          reportError(error)
          track?.(entry, performance.now() - startedAt, error)
          return
        }
        track?.(entry, performance.now() - startedAt)
      }),
    )
  }

  /** 顺序执行监听器；单个失败不阻断后续（与 emit 一致），除非监听器自行抛出中断。 */
  async serial(name: string, ...args: unknown[]): Promise<void> {
    const list = this.snapshot(name)
    const track = this.tracker(name, 'serial', list.length)

    for (const entry of list) {
      const startedAt = track ? performance.now() : 0
      try {
        await invoke(entry.listener)(...args)
      } catch (error) {
        reportError(error)
        track?.(entry, performance.now() - startedAt, error)
        continue
      }
      track?.(entry, performance.now() - startedAt)
    }
  }

  /** 顺序执行，返回第一个非 undefined 的结果；常用于画布 drop、快捷键处理。 */
  async bail<T>(name: string, ...args: unknown[]): Promise<T | undefined> {
    const list = this.snapshot(name)
    const track = this.tracker(name, 'bail', list.length)

    for (const entry of list) {
      const startedAt = track ? performance.now() : 0
      let result: unknown
      try {
        result = await invoke(entry.listener)(...args)
      } catch (error) {
        reportError(error)
        track?.(entry, performance.now() - startedAt, error)
        continue
      }
      track?.(entry, performance.now() - startedAt)
      if (result !== undefined) return result as T
    }
    return undefined
  }

  /**
   * 管线式执行：前一个监听器的返回值作为下一个的输入。
   *
   * 本模式不隔离错误：监听器抛错会上报监视器后原样抛出，调用方必须兜住。
   */
  async waterfall<T>(name: string, input: T, ...args: unknown[]): Promise<T> {
    const list = this.snapshot(name)
    const track = this.tracker(name, 'waterfall', list.length)

    let value = input
    for (const entry of list) {
      const startedAt = track ? performance.now() : 0
      try {
        value = (await invoke(entry.listener)(value, ...args)) as T
      } catch (error) {
        track?.(entry, performance.now() - startedAt, error)
        throw error
      }
      track?.(entry, performance.now() - startedAt)
    }
    return value
  }

  /**
   * 为本次分发创建计时回调。
   *
   * 无监视器时返回 undefined，让热路径跳过取时间戳与建记录；分发模式、事件名与
   * 监听器数量在分发开始前就固定，所以只创建一次闭包。
   */
  private tracker(name: string, mode: DispatchMode, listenerCount: number): Tracker | undefined {
    if (this.monitors.size === 0) return undefined

    return (entry, duration, error) => {
      const record: EventDispatchRecord = {
        name,
        mode,
        pluginId: entry.owner?.id,
        duration,
        listenerCount,
      }
      if (error !== undefined) record.error = error
      for (const monitor of [...this.monitors]) {
        try {
          monitor(record)
        } catch (caught) {
          reportMonitorError(caught)
        }
      }
    }
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
