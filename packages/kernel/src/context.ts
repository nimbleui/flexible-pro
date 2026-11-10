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
 *
 * 名单比契约层的 15 个服务名更宽，两处差异都是有意的：
 * - `http`、`storage`、`telemetry` 等尚未实现的名字先占住，避免将来加入平台能力时
 *   撞上「第三方插件早已提供同名服务」的破坏性变更；
 * - `expression`、`keybinding` 不列入，这两类允许插件替换自己的实现；
 * - `toast`、`navigation` 同样不列入：它们是宿主 UI 能力的适配位，插件提供更好看的
 *   提示实现或接管跳转是正当用法，不像 `canvas`、`history` 那样承载内核语义。
 */
export const RESERVED_SERVICES: ReadonlySet<string> = new Set([
  'material',
  'setter',
  'renderer',
  'dataSource',
  'pageState',
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
  'version',
])

/**
 * 服务观察器。
 *
 * 插件查询可选依赖或做晚绑定（`ctx.inject`）时使用；它不暴露内部服务表，
 * 只广播「某个作用域提供或移除了某个名字」这一事实，对本作用域是否可见
 * 由订阅方自己重新 `get` 判定。
 */
export class ServiceObserver {
  private listeners = new Set<(name: string, value: unknown) => void>()

  /**
   * 订阅服务变化。
   *
   * 观察器全应用只有一个（子 Context 沿用父级实例），因此其他 Realm 的 `provide`
   * 同样会送达这里，回调只给出名字与该层的新值；订阅者需要自行过滤名字并重新
   * `get`，才能确认变化对本作用域链可见。
   *
   * @returns 注销句柄，应交给 `ctx.effect` 托管
   */
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

  private listeners = new Set<(record: DiagnosticRecord) => void>()

  /**
   * 记录一条诊断并同时输出到控制台。
   *
   * 记录有上限，超出后淘汰最早的一条，因此长时间运行只能看到最近一段历史；
   * 本方法不抛错，调用方可以在 catch 分支里直接上报。
   *
   * @param error 原始错误；非 Error 会被字符串化成 message
   * @param detail 附加上下文，其中 `scope` 用于区分发生阶段，缺失时记为 `unknown`
   */
  report(error: unknown, detail: Record<string, unknown> = {}): void {
    const message = error instanceof Error ? error.message : String(error)
    const record: DiagnosticRecord = {
      scope: typeof detail.scope === 'string' ? detail.scope : 'unknown',
      message,
      error,
      detail,
      timestamp: Date.now(),
    }
    this.records.push(record)
    if (this.records.length > DIAGNOSTIC_LIMIT) this.records.shift()
    console.error(`[lowcode] ${message}`, detail)

    // 订阅者是 devtools 这类展示层代码，它抛错不能反过来影响上报方，
    // 否则会破坏本方法「不抛错」的约定。
    for (const listener of [...this.listeners]) {
      try {
        listener(record)
      } catch (caught) {
        console.error('[lowcode] 诊断订阅者执行失败', caught)
      }
    }
  }

  /** 取当前记录快照；返回的是副本，devtools 可以安全持有。 */
  list(): readonly DiagnosticRecord[] {
    return [...this.records]
  }

  /**
   * 订阅新记录写入；devtools 与错误面板据此实时刷新，不必轮询 `list()`。
   *
   * 只通知 `report` 新增的记录，回放历史仍要走 `list()`。
   *
   * @returns 注销句柄
   */
  onChange(listener: (record: DiagnosticRecord) => void): Disposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
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
  /** 根上下文；runtime、服务观察器与诊断表各只有一份，都挂在它身上 */
  readonly root: Context

  /** 本实例的副作用桶；不与父级或兄弟插件共享，dispose 时逆序回收 */
  readonly effects: EffectScope

  /**
   * 停用信号。
   *
   * runtime 在 `apply` 返回后检查它，丢弃已停用插件的结果；异步 `apply` 内部
   * 也应自查，避免在插件已被卸载后继续注册资源或写入服务。
   */
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

  /** 仅供 dispose 幂等判定；与 signal.aborted 是两件事，原因见 dispose 内注释 */
  private disposed = false

  /**
   * 内核私有总线；root 创建，子 Context 继承，公共 API 不暴露。
   *
   * @internal
   */
  readonly internalBus: InternalBus

  /**
   * 由 `createApp` 建根上下文、`PluginRuntime.activate` 建插件上下文、
   * `Context.fork` / `spawn` 建隔离与晚绑定上下文四处调用。
   *
   * 共享与独立的划分是刻意的：`bus`、`internalBus`、服务观察器与诊断一律沿用父实例，
   * 保证事件分发和晚绑定看得到全局；`scope`、`abort`、`effects` 各自新建，
   * 保证每个 Context 能独立遮蔽服务、独立中止、独立回收。
   *
   * @param parent 父 Context；根上下文传 null
   * @param record 归属的插件实例；fork 出的子 Context 沿用父级 record，因此不额外登记
   * @param scope 本层服务作用域，遮蔽链由 `scope.parent` 决定，与 parent 字段可以不同
   * @param abort 本实例的中止控制器；runtime 会为插件实例留存一份，以便在停用时单独触发
   * @param bus 面向插件的公共事件总线
   * @param internalBus 仅当 parent 为 null 时生效，否则一律继承父级
   */
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

  /**
   * 沿作用域链查找服务；找不到返回 undefined。
   *
   * `isolate` 给本层设的 `filter` 是整层跳过：名单外的服务不在这里比对，直接继续向
   * 父层查找，所以隔离层只可能为名单内的名字提供替换实现。
   *
   * 契约层安装的 `ctx.<service>` 访问器全部走本方法而不是 `require`，因此类型上标注
   * 为必选的应用级服务，在对应插件尚未提供时同样只会得到 undefined。
   */
  get<T>(name: string): T | undefined {
    for (let scope: ServiceScope | undefined = this.scope; scope; scope = scope.parent) {
      if (scope.filter && !scope.filter.has(name)) continue
      const entry = scope.services.get(name)
      if (entry) return entry.value as T
    }
    return undefined
  }

  /**
   * 查找服务，缺失即抛错。
   *
   * 用于「没有它本插件无法工作」的硬依赖；可选依赖应该用 `get` 或 `inject`，
   * 否则会把可降级的功能变成整个插件的启动失败。
   */
  require<T>(name: string): T {
    const value = this.get<T>(name)
    if (value === undefined) throw new Error(`[lowcode] 缺少服务 "${name}"`)
    return value
  }

  /**
   * 在本层作用域注册服务，并同时通知观察器与内核私有总线。
   *
   * 冲突只比对当前 scope：父层同名不算冲突，而是合法遮蔽，这正是 Realm 能覆盖
   * 全局服务实现的机制。注销句柄已由 `effects` 托管，插件不需要手动 dispose。
   *
   * @param name 服务名；保留服务需要授权与 `apiVersion`
   * @param value 服务实例
   * @param options 覆盖、授权与契约版本选项
   * @returns 注销句柄；只删除自己注册的这条记录，覆盖场景不会误删后来者
   * @throws 在隔离层提供名单外的服务、保留服务缺少授权、保留服务未声明
   * `apiVersion`、同层已被他人提供且未要求覆盖、覆盖未获授权时抛错
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

  /**
   * 登记副作用；推荐所有资源注册都走它。
   *
   * @param factory 创建资源；本 Context 已销毁时不会执行，直接返回空句柄，
   * 因此异步 `apply` 晚到的注册不会留下无人回收的监听器
   */
  effect<T extends Disposable>(factory: () => T): T {
    return this.effects.effect(factory)
  }

  /**
   * 可选依赖晚绑定。
   *
   * 依赖齐全时执行 callback，callback 拥有独立子作用域；
   * 任一依赖消失时销毁该子作用域，不重启父插件；依赖再次齐全时重新执行。
   *
   * @param names 依赖的服务名，全部按「当前 Context 可见」判定
   * @param callback 收到与本 Context 共享 service scope 的子 Context，
   * 其中注册的副作用随依赖消失一起回收
   * @returns 注销句柄，由本 Context 的 effects 托管
   * @throws names 为空时抛错
   */
  inject(names: string[], callback: (ctx: Context) => void): Disposable {
    return this.root.runtime.inject(this, names, callback)
  }

  /**
   * 注册事件监听，注销随本 Context 销毁。
   *
   * 事件名与处理器签名由 `Events` 表约束；该表集中在 `@lc/contracts` 扩展，
   * 插件不得自行 `declare module`。
   *
   * 本方法会把当前实例记录交给总线，供 devtools 把事件归到注册它的插件上；
   * 直接调用 `bus.add` 的注册没有这个归属信息。
   *
   * @param options `prepend` 优先于 `priority`；其余按 `priority` 从大到小排序
   */
  on<K extends keyof Events & string>(
    name: K,
    listener: Events[K],
    options?: EventOptions,
  ): Disposable {
    return this.effects.effect(() => this.bus.add(name, listener, options, this.record))
  }

  /** 同步广播事件；单个监听器抛错只被记录，不影响其余监听器。 */
  emit<K extends keyof Events & string>(name: K, ...args: Parameters<Events[K]>): void {
    this.bus.emit(name, ...args)
  }

  /**
   * 顺序执行监听器，第一个非 undefined 的结果生效。
   *
   * 用于「谁认领这次操作」的抢占式分发，例如画布 drop 与快捷键处理。监听器抛错
   * 只被记录，会继续问下一个。`name` 受 `Events` 表约束，但 `args` 退化为
   * `unknown[]`：这两个模式为了拿到泛型返回值放弃了参数推断，调用点需自行对齐签名。
   *
   * @returns 命中时为该监听器的返回值；全部未命中或无人注册时为 undefined
   */
  bail<T>(name: keyof Events & string, ...args: unknown[]): Promise<T | undefined> {
    return this.bus.bail<T>(name, ...args)
  }

  /**
   * 管线式执行：前一个监听器的返回值作为下一个的输入。
   *
   * 与 `emit`、`bail` 不同，本模式不做错误隔离：任一监听器抛错会中断整条管线，
   * 并让返回的 Promise reject，调用方必须自己兜住。参数约束同 `bail`。
   *
   * @returns 依次变换后的最终值；没有任何监听器时原样返回 `input`
   */
  waterfall<T>(name: keyof Events & string, input: T, ...args: unknown[]): Promise<T> {
    return this.bus.waterfall(name, input, ...args)
  }

  /**
   * 以当前 Context 为父加载插件实例。
   *
   * 返回时插件只完成登记：`apply` 要到 runtime 的微任务批里才执行，所以不能假设
   * 本行之后它提供的服务已经存在。需要等待就绪用 `this.root.runtime.whenIdle()`。
   *
   * @param definition 插件定义
   * @param config 原始配置；激活时才与 intercept 覆盖合并并过 schema 校验
   * @param options 实例 id 等加载选项
   * @returns 实例元数据，其状态此刻仍是 `loading`；实例可挂多个，唯一键是 id 不是 name
   * @throws 同一实例 id 重复加载时抛错
   */
  plugin(definition: PluginDefinition, config?: unknown, options?: LoadOptions): PluginRecord {
    return this.root.runtime.load(this, definition, config, options)
  }

  /**
   * 新建 service scope：用于文档 Realm、预览隔离等。
   *
   * 子 Context 沿用父级的 record、bus 与 internalBus，只换 scope 与中止控制器，
   * 因此它能遮蔽父层服务而不引入新的事件通道。它不是插件实例，不会进入 `children`，
   * 必须由创建方自己 `dispose`。
   *
   * @param options `filter` 限定本层参与的服务名，省略表示不限制
   */
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

  /**
   * 只隔离指定服务；overrides 会预先放入隔离层。
   *
   * overrides 通常是 `document`、`history` 这类保留服务，直接 provide 会被授权检查
   * 拦下。这里借「fork 复用父级 record」这一点，为 `names` 列出的服务自签一张只在
   * 本层生效的一次性授权：名单外的保留服务依然过不了 `provide` 的校验。
   *
   * @param names 需要隔离替换的服务名，同时充当本层的可见名单
   * @param overrides 预先写入隔离层的服务实例，键必须来自 `names`
   */
  isolate(names: string[], overrides: Record<string, unknown> = {}): Context {
    const fork = this.fork({ filter: names })
    const grant: ServiceGrant = { pluginId: fork.record.name, names }
    for (const [name, value] of Object.entries(overrides)) {
      fork.provide(name, value, { grant, apiVersion: '1.0' })
    }
    return fork
  }

  /**
   * 子树级配置覆盖；对 ctx 及其后代挂载的插件生效。
   *
   * 配置只在激活时解析一次，所以覆盖对已经 active 的插件无效，要等它因依赖变化或
   * 重启重新激活后才读得到。同一 key 重复调用是 `deepMerge` 累积，不是整体替换。
   *
   * @param key 插件的逻辑名（`definition.name`），不是实例 id
   * @param patch 覆盖片段；数组按整体替换处理，见 `deepMerge`
   * @returns 注销句柄；回收后恢复调用前的覆盖值，原本没有则移除该 key
   */
  intercept(key: string, patch: object): Disposable {
    const previous = this.intercepts.get(key)
    this.intercepts.set(key, deepMerge(previous ?? {}, patch))
    return this.effects.add(() => {
      if (previous) this.intercepts.set(key, previous)
      else this.intercepts.delete(key)
    })
  }

  /** 销毁上下文：先卸载子插件，再回收本层副作用；重复调用只生效一次。 */
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

  /**
   * 判断本插件是否有权提供 `name`。
   *
   * 授权有两条来源：调用方每次传入的 `grant`（loader 逐次签发、`isolate` 自签），
   * 或回落到 root runtime 里的常驻授权表（`createApp` 的 grants 预置）。
   * 显式 grant 必须归属当前插件，否则视为拿别人的授权来注册，直接抛错。
   */
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

  /**
   * 判断是否有权覆盖同层已有的提供者。
   *
   * 覆盖是独立于「提供」的授权位：拿到提供权不代表能顶掉别人已注册的实现，
   * 所以这里只看 override 标志，不复用 `isGranted` 的结果。
   */
  private isOverrideGranted(name: string, options: ProvideOptions): boolean {
    if (options.grant) return Boolean(options.grant.override)
    return this.root.runtime?.hasGrant(this.record.name, name, true) ?? false
  }
}

/**
 * 已安装过的服务名。
 *
 * 与 `installServiceAccessors` 里的原型 own-property 检查一起构成两道幂等保障：
 * 前者避免重复定义，后者保证不覆盖已经存在于 `Context.prototype` 上的同名属性。
 */
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
