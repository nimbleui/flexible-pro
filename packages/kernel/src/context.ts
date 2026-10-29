import { deepMerge } from './config'
import { EffectScope } from './effect'
import type { EventBus } from './events'
import type { InternalBus } from './internal'
import type { PluginRuntime } from './runtime'
import type {
  Disposable,
  EventOptions,
  Events,
  ForkOptions,
  LoadOptions,
  PluginDefinition,
  PluginRecord,
} from './types'

/** 服务注册记录。 */
export interface ServiceEntry {
  /** 服务实例 */
  value: unknown
  /** 提供者，用于冲突提示和依赖图 */
  owner: PluginRecord
  /** 服务契约版本，如 `1.0`；保留服务必填，loader 激活前校验 */
  apiVersion: string
}

/** 服务解析链的一层；Realm 与 isolate 通过 parent 形成遮蔽链。 */
export interface ServiceScope {
  /** 上层作用域 */
  parent?: ServiceScope
  /** 本层注册的服务 */
  services: Map<string, ServiceEntry>
  /** null 表示不过滤；Set 表示本层只对列出的服务生效 */
  filter: Set<string> | null
}

/** 平台签发的服务授权。 */
export interface ServiceGrant {
  /** 被授权的插件 id；必须与提供者 record.name 一致 */
  pluginId: string
  /** 允许提供的服务名 */
  names: readonly string[]
  /** 是否允许覆盖同层现有提供者 */
  override?: boolean
}

/** provide 选项。 */
export interface ProvideOptions {
  /** 是否覆盖同层现有提供者；需要 override 授权 */
  replace?: boolean
  /** loader 签发的服务授权；内置服务由 createApp 预置 */
  grant?: ServiceGrant
  /** 服务契约版本；保留服务必填 */
  apiVersion?: string
}

/**
 * 平台保留服务名：只能由平台核心或认证实现提供。
 *
 * 保留名单存在的意义不是防住同 realm 的恶意代码（它做不到），
 * 而是防止普通插件无意间覆盖 `canvas`、`history` 这类内核语义服务。
 */
export const RESERVED_SERVICES: ReadonlySet<string> = new Set([
  'material',
  'setter',
  'renderer',
  'dataSource',
  'command',
  'action',
  'document',
  'history',
  'selection',
  'designer',
  'canvas',
  'snap',
  'http',
  'storage',
  'audit',
  'policy',
  'quota',
  'secrets',
  'flags',
  'telemetry',
  'loader',
  'contribution',
  'modules',
  'workspace',
])

/**
 * 服务观察器。
 *
 * 插件查询可选依赖或做晚绑定（`ctx.inject`）时使用；
 * 它只报告「本作用域链上可见实例」的变化，不暴露内部服务表。
 */
export class ServiceObserver {
  private listeners = new Set<(name: string, value: unknown) => void>()

  onDidChange(listener: (name: string, value: unknown) => void): Disposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  /** @internal 由 Context.provide 调用 */
  notify(name: string, value: unknown): void {
    for (const listener of [...this.listeners]) listener(name, value)
  }
}

/** 单条诊断记录。 */
export interface DiagnosticRecord {
  /** 发生区域，如 `interaction`、`apply` */
  scope: string
  /** 可读描述 */
  message: string
  /** 原始错误 */
  error?: unknown
  /** 附加信息（插件 id、处理器 id 等） */
  detail?: Record<string, unknown>
  /** 记录时间戳（毫秒） */
  timestamp: number
}

const DIAGNOSTIC_LIMIT = 200

/**
 * 诊断收集器。
 *
 * 只用于 devtools 与错误面板展示，不参与生命周期决策，
 * 因此插件即使伪造内容也无法影响插件状态。
 */
export class Diagnostics {
  private records: DiagnosticRecord[] = []

  report(error: unknown, detail: Record<string, unknown> = {}): void {
    const message = error instanceof Error ? error.message : String(error)
    this.records.push({
      scope: typeof detail.scope === 'string' ? detail.scope : 'unknown',
      message,
      error,
      detail,
      timestamp: Date.now(),
    })
    if (this.records.length > DIAGNOSTIC_LIMIT) this.records.shift()
    console.error(`[lowcode] ${message}`, detail)
  }

  list(): readonly DiagnosticRecord[] {
    return [...this.records]
  }
}

/**
 * 插件运行上下文。
 *
 * 核心不变量：
 * 1. 一个插件一个 Context，但默认与父插件共享 service scope，兄弟插件可见彼此服务；
 * 2. `fork()` 创建新 scope，用于 Realm 与 isolate；子 scope 只在自身提供过服务时遮蔽父级；
 * 3. `get()` 沿 scope 链向上查找，找不到返回 undefined；`inject` 保证启动时一定存在；
 * 4. `provide()` 只检查当前 scope 冲突，跨层同名是合法的遮蔽；
 * 5. 所有监听、服务、定时器都挂在当前 Context 的 EffectScope 上，Context 销毁即全部回收。
 */
export class Context {
  readonly root: Context

  readonly effects: EffectScope

  readonly signal: AbortSignal

  /** 子树级配置覆盖；键为插件名，值为覆盖片段 */
  readonly intercepts = new Map<string, object>()

  /** 由 createApp 注入；只有 root 持有实际实例 */
  runtime!: PluginRuntime

  /** 服务观察接口；插件查询可选依赖用 */
  readonly services: ServiceObserver

  /** 诊断接口；host/devtools 用，不能伪造生命周期 */
  readonly diagnostics: Diagnostics

  /** 直接挂载在本 Context 下的子插件；Realm 靠它精确卸载子树 */
  readonly children = new Set<PluginRecord>()

  private disposed = false

  /**
   * 内核私有总线；root 创建，子 Context 继承，公共 API 不暴露。
   *
   * @internal
   */
  readonly internalBus: InternalBus

  constructor(
    readonly parent: Context | null,
    readonly record: PluginRecord,
    readonly scope: ServiceScope,
    private readonly abort: AbortController,
    readonly bus: EventBus,
    internalBus: InternalBus,
  ) {
    this.root = parent?.root ?? this
    this.internalBus = parent?.internalBus ?? internalBus
    this.signal = abort.signal
    this.effects = new EffectScope()
    this.services = parent?.services ?? new ServiceObserver()
    this.diagnostics = parent?.diagnostics ?? new Diagnostics()
  }

  /** 沿作用域链查找服务；找不到返回 undefined。 */
  get<T>(name: string): T | undefined {
    for (let scope: ServiceScope | undefined = this.scope; scope; scope = scope.parent) {
      if (scope.filter && !scope.filter.has(name)) continue
      const entry = scope.services.get(name)
      if (entry) return entry.value as T
    }
    return undefined
  }

  /** 查找必须存在的服务；缺失时抛错。 */
  require<T>(name: string): T {
    const value = this.get<T>(name)
    if (value === undefined) throw new Error(`[lowcode] 缺少服务 "${name}"`)
    return value
  }

  /**
   * 注册服务。
   *
   * @throws 命名空间被隔离、保留服务未授权、同层冲突、覆盖未授权时抛错。
   */
  provide<T>(name: string, value: T, options: ProvideOptions = {}): Disposable {
    if (this.scope.filter && !this.scope.filter.has(name)) {
      throw new Error(`[lowcode] 服务 "${name}" 不允许在隔离层内提供`)
    }

    if (RESERVED_SERVICES.has(name) && !this.isGranted(name, options)) {
      throw new Error(`[lowcode] 服务 "${name}" 为平台保留，需要 ServiceGrant`)
    }
    if (RESERVED_SERVICES.has(name) && !options.apiVersion) {
      throw new Error(`[lowcode] 保留服务 "${name}" 必须声明 apiVersion`)
    }

    const existing = this.scope.services.get(name)
    if (existing && !options.replace) {
      throw new Error(`[lowcode] 服务 "${name}" 已被插件 "${existing.owner.name}" 提供`)
    }
    if (existing && options.replace && !this.isOverrideGranted(name, options)) {
      throw new Error(`[lowcode] 覆盖服务 "${name}" 需要 override 授权`)
    }

    const entry: ServiceEntry = {
      value,
      owner: this.record,
      apiVersion: options.apiVersion ?? '0.0',
    }
    this.scope.services.set(name, entry)
    this.services.notify(name, value)
    this.internalBus.emit('service', name, value, this.record)

    return this.effects.add(() => {
      // 只删除自己注册的那一条，避免覆盖场景误删后来者
      if (this.scope.services.get(name) !== entry) return
      this.scope.services.delete(name)
      this.services.notify(name, undefined)
      this.internalBus.emit('service', name, undefined, this.record)
    })
  }

  /** 登记副作用；推荐所有资源注册都走它。 */
  effect<T extends Disposable>(factory: () => T): T {
    return this.effects.effect(factory)
  }

  /**
   * 可选依赖晚绑定。
   *
   * 依赖齐全时执行 callback，callback 拥有独立子作用域；
   * 任一依赖消失时销毁该子作用域，不重启父插件；依赖再次齐全时重新执行。
   */
  inject(names: string[], callback: (ctx: Context) => void): Disposable {
    return this.root.runtime.inject(this, names, callback)
  }

  on<K extends keyof Events & string>(
    name: K,
    listener: Events[K],
    options?: EventOptions,
  ): Disposable {
    return this.effects.effect(() => this.bus.add(name, listener, options))
  }

  emit<K extends keyof Events & string>(name: K, ...args: Parameters<Events[K]>): void {
    this.bus.emit(name, ...args)
  }

  /** 顺序执行监听器，第一个非 undefined 的结果生效。 */
  bail<T>(name: keyof Events & string, ...args: unknown[]): Promise<T | undefined> {
    return this.bus.bail<T>(name, ...args)
  }

  /** 管线式执行：前一个监听器的返回值作为下一个的输入。 */
  waterfall<T>(name: keyof Events & string, input: T, ...args: unknown[]): Promise<T> {
    return this.bus.waterfall(name, input, ...args)
  }

  /** 以当前 Context 为父加载插件实例。 */
  plugin(definition: PluginDefinition, config?: unknown, options?: LoadOptions): PluginRecord {
    return this.root.runtime.load(this, definition, config, options)
  }

  /** 新建 service scope：用于文档 Realm、预览隔离等。 */
  fork(options: ForkOptions = {}): Context {
    return new Context(
      this,
      this.record,
      {
        parent: this.scope,
        services: new Map(),
        filter: options.filter ? new Set(options.filter) : null,
      },
      new AbortController(),
      this.bus,
      this.internalBus,
    )
  }

  /** 只隔离指定服务；overrides 会预先放入隔离层。 */
  isolate(names: string[], overrides: Record<string, unknown> = {}): Context {
    const fork = this.fork({ filter: names })
    const grant: ServiceGrant = { pluginId: fork.record.name, names }
    for (const [name, value] of Object.entries(overrides)) {
      fork.provide(name, value, { grant, apiVersion: '1.0' })
    }
    return fork
  }

  /** 子树级配置覆盖；对 ctx 及其后代挂载的插件生效。 */
  intercept(key: string, patch: object): Disposable {
    const previous = this.intercepts.get(key)
    this.intercepts.set(key, deepMerge(previous ?? {}, patch))
    return this.effects.add(() => {
      if (previous) this.intercepts.set(key, previous)
      else this.intercepts.delete(key)
    })
  }

  /** 销毁上下文：先卸载子插件，再回收本层副作用。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // 先 abort 让异步任务停止，再回收副作用；两者的守卫必须分开，
    // 否则 runtime.deactivate 中「先 abort 后 dispose」会让 dispose 直接被短路。
    this.abort.abort()
    for (const child of [...this.children].reverse()) {
      this.root.runtime?.unload(child.id)
    }
    this.children.clear()
    this.effects.dispose()
  }

  /**
   * 创建共享 service scope 的子上下文（独立 effects / signal）。
   *
   * 供运行时晚绑定与画布手势等「借用当前插件作用域」的场景使用；
   * 不会进入 children（它不是插件实例），由创建方负责销毁。
   *
   * @internal
   */
  spawn(): Context {
    return new Context(
      this,
      this.record,
      this.scope,
      new AbortController(),
      this.bus,
      this.internalBus,
    )
  }

  /**
   * 收集从 root 到当前 Context 的 intercept 覆盖（后者优先）。
   *
   * @internal 由 runtime 解析配置时使用。
   */
  collectIntercepts(): Map<string, object> {
    const chain: Context[] = []
    for (let current: Context | null = this; current; current = current.parent) {
      chain.unshift(current)
    }

    const merged = new Map<string, object>()
    for (const context of chain) {
      for (const [key, patch] of context.intercepts) {
        merged.set(key, deepMerge(merged.get(key) ?? {}, patch))
      }
    }
    return merged
  }

  private isGranted(name: string, options: ProvideOptions): boolean {
    const grant = options.grant
    if (grant) {
      if (grant.pluginId !== this.record.name) {
        throw new Error(`[lowcode] ServiceGrant 不属于插件 "${this.record.name}"`)
      }
      return grant.names.includes(name)
    }
    return this.root.runtime?.hasGrant(this.record.name, name) ?? false
  }

  private isOverrideGranted(name: string, options: ProvideOptions): boolean {
    if (options.grant) return Boolean(options.grant.override)
    return this.root.runtime?.hasGrant(this.record.name, name, true) ?? false
  }
}

const installedAccessors = new Set<string>()

/**
 * 为 Context 安装服务属性访问器：`ctx.material` → `ctx.get('material')`。
 *
 * 为什么需要：contracts 通过 declaration merging 给 Context 增加服务属性，
 * 但那只是类型声明；运行时必须有同名 getter 才能让 `ctx.canvas` 真正取值。
 *
 * 内核不内置任何业务服务名：名单由平台契约层提供，内核只负责安装机制。
 * 幂等，可在多次 createApp 前安全调用。
 */
export function installServiceAccessors(names: readonly string[]): void {
  for (const name of names) {
    if (installedAccessors.has(name)) continue
    if (Object.prototype.hasOwnProperty.call(Context.prototype, name)) continue

    Object.defineProperty(Context.prototype, name, {
      configurable: true,
      get(this: Context) {
        return this.get(name)
      },
    })
    installedAccessors.add(name)
  }
}
