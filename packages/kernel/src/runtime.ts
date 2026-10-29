import { resolveConfig } from './config'
import { Context } from './context'
import type { InternalBus } from './internal'
import type { Disposable, LoadOptions, PluginDefinition, PluginRecord } from './types'
import { normalizeInject } from './types'

interface InternalRecord extends PluginRecord {
  definition: PluginDefinition
  /** 父上下文；依赖与子插件都挂在这里 */
  parentCtx: Context
  abort: AbortController | null
  /** 激活时解析到的依赖实例，用于判断服务身份是否变化 */
  resolved: Map<string, unknown>
}

/**
 * 插件运行时：依赖检查、激活、停用、卸载与调度。
 *
 * 调度采用微任务批处理，避免 apply 内同步创建插件导致递归激活；
 * 服务出现/消失是驱动整个生命周期的唯一信号。
 */
export class PluginRuntime {
  private seq = 0

  private records = new Map<string, InternalRecord>()

  private queue = new Set<string>()

  /** 所有排队中/执行中的激活任务，供 whenIdle 等待 */
  private pending = new Set<Promise<void>>()

  /** 平台签发的服务授权：pluginId → service → 是否允许覆盖 */
  private grants = new Map<string, Map<string, { override: boolean }>>()

  private readonly internal: InternalBus

  constructor(private readonly app: Context) {
    this.internal = app.internalBus
    this.internal.on('service', (name, value) => this.onServiceChange(name, value))
  }

  /**
   * 签发服务授权。
   *
   * 生产环境由 loader / createApp 在校验签名与认证等级后调用；
   * 骨架阶段由 bootstrap 为内置服务插件预置。
   */
  grant(
    pluginId: string,
    names: readonly string[],
    options: { override?: boolean } = {},
  ): void {
    const map = this.grants.get(pluginId) ?? new Map<string, { override: boolean }>()
    for (const name of names) {
      map.set(name, { override: Boolean(options.override) })
    }
    this.grants.set(pluginId, map)
  }

  /** 查询插件是否持有某个服务的提供权。 */
  hasGrant(pluginId: string, name: string, needOverride = false): boolean {
    const entry = this.grants.get(pluginId)?.get(name)
    if (!entry) return false
    return needOverride ? entry.override : true
  }

  /** 加载插件实例并进入调度队列。 */
  load(
    parent: Context,
    definition: PluginDefinition,
    rawConfig?: unknown,
    options: LoadOptions = {},
  ): PluginRecord {
    const id = options.id ?? `${definition.name}#${++this.seq}`
    if (this.records.has(id)) {
      throw new Error(`[lowcode] 插件实例 id 重复: ${id}`)
    }

    const record: InternalRecord = {
      id,
      name: definition.name,
      state: 'loading',
      definition,
      rawConfig,
      config: undefined,
      context: null,
      parent: parent.record,
      inject: normalizeInject(definition.inject),
      provides: definition.provides ?? [],
      error: undefined,
      attempts: 0,
      parentCtx: parent,
      abort: null,
      resolved: new Map(),
    }

    parent.children.add(record)
    this.records.set(id, record)
    this.schedule(id)
    return record
  }

  /** 卸载插件实例：回收其全部副作用与子插件。 */
  unload(id: string): void {
    const record = this.records.get(id)
    if (!record || record.state === 'disposed') return

    // 只发一次 disposed，避免 pending → disposed 双事件
    this.deactivate(record, 'pending', false)
    record.state = 'disposed'
    record.parentCtx.children.delete(record)
    this.records.delete(id)
    this.internal.emit('plugin', record)
  }

  /**
   * 等待当前所有激活任务结束。
   *
   * 激活过程中新创建的插件也会被追踪，因此 bootstrap 可以在一次 await 后
   * 直接使用预设提供的服务，而不依赖外部延时。
   */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending])
    }
  }

  /** 卸载全部实例（应用销毁时调用）。 */
  dispose(): void {
    for (const record of [...this.records.values()].reverse()) {
      this.unload(record.id)
    }
    this.records.clear()
  }

  /**
   * 可选依赖晚绑定（`ctx.inject` 的实现）。
   *
   * 依赖齐全时创建一个共享 service scope 的子上下文执行 callback；
   * 任一依赖消失时销毁子上下文，但不会让父插件进入 pending。
   */
  inject(ctx: Context, names: string[], callback: (ctx: Context) => void): Disposable {
    if (names.length === 0) {
      throw new Error('[lowcode] ctx.inject 至少需要一个依赖')
    }

    let scope: Context | null = null
    const bind = (): void => {
      const ready = names.every((name) => ctx.get(name) !== undefined)

      if (ready && !scope) {
        const child = ctx.spawn()
        scope = child
        try {
          callback(child)
        } catch (error) {
          child.dispose()
          scope = null
          ctx.diagnostics.report(error, { scope: 'inject', dependencies: names.join(',') })
        }
        return
      }

      if (!ready && scope) {
        scope.dispose()
        scope = null
      }
    }

    const off = ctx.services.onDidChange((name) => {
      if (names.includes(name)) queueMicrotask(bind)
    })
    bind()

    return ctx.effects.add(() => {
      off.dispose()
      scope?.dispose()
      scope = null
    })
  }

  private schedule(id: string): void {
    this.queue.add(id)
    // 已有一批待处理任务时直接并入，避免同步递归激活
    if (this.queue.size > 1) return

    const task = (async () => {
      await Promise.resolve()
      const ids = [...this.queue]
      this.queue.clear()
      await Promise.all(ids.map((recordId) => this.activate(recordId)))
    })()
    this.track(task)
  }

  private track(task: Promise<void>): void {
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
  }

  private async activate(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) return
    if (
      record.state === 'active' ||
      record.state === 'applying' ||
      record.state === 'disposing' ||
      record.state === 'disposed'
    ) {
      return
    }

    // 依赖检查读父上下文，不读自己上次激活残留的服务
    const missing = record.inject.required.filter(
      (name) => record.parentCtx.get(name) === undefined,
    )
    if (missing.length > 0) {
      record.state = 'pending'
      return
    }

    record.resolved = new Map(
      [...record.inject.required, ...record.inject.optional].map((name) => [
        name,
        record.parentCtx.get(name),
      ]),
    )

    const abort = new AbortController()
    const context = new Context(
      record.parentCtx,
      record,
      record.parentCtx.scope,
      abort,
      record.parentCtx.bus,
      record.parentCtx.internalBus,
    )
    record.abort = abort
    record.context = context
    context.record.context = context

    let config: unknown
    try {
      config = resolveConfig(record.definition, record.rawConfig, context.collectIntercepts())
    } catch (error) {
      this.fail(record, error, 'config')
      return
    }

    record.state = 'applying'
    record.attempts += 1
    try {
      await record.definition.apply(
        context as Context & Parameters<PluginDefinition['apply']>[0],
        config,
      )
      if (record.state !== 'applying' || abort.signal.aborted) return
      record.config = config
      record.state = 'active'
      this.internal.emit('plugin', record)
    } catch (error) {
      this.fail(record, error, 'apply')
    }
  }

  private onServiceChange(name: string, value: unknown): void {
    if (value !== undefined) {
      for (const record of [...this.records.values()]) {
        if (record.state === 'pending' && this.dependenciesReady(record)) {
          this.schedule(record.id)
        }
      }
      return
    }

    for (const record of [...this.records.values()]) {
      if (record.state !== 'active' && record.state !== 'applying') continue

      // 可选依赖也视为依赖：避免插件继续持有已失效的服务引用
      const dependsOn =
        record.inject.required.includes(name) || record.inject.optional.includes(name)
      if (!dependsOn) continue

      // 同名服务可能来自其他 Realm；依赖者当前解析结果没变就不重启
      if (record.parentCtx.get(name) === record.resolved.get(name)) continue
      this.deactivate(record, 'pending')
    }
  }

  private dependenciesReady(record: InternalRecord): boolean {
    return record.inject.required.every((name) => record.parentCtx.get(name) !== undefined)
  }

  private fail(record: InternalRecord, error: unknown, phase: 'config' | 'apply'): void {
    record.error = error
    this.internal.emit('error', {
      cause: error,
      pluginId: record.id,
      pluginName: record.name,
      phase,
    })
    this.deactivate(record, 'failed')
  }

  private deactivate(record: InternalRecord, next: 'pending' | 'failed', emit = true): void {
    if (record.state === 'disposed' || record.state === 'disposing') return
    record.state = 'disposing'
    record.abort?.abort()

    // Context.dispose 会先逆序卸载子插件，再回收本插件的副作用
    record.context?.dispose()
    record.context = null
    record.config = undefined
    record.resolved.clear()
    record.state = next
    if (emit) this.internal.emit('plugin', record)
  }
}
