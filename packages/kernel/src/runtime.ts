import { resolveConfig } from './config'
import { Context } from './context'
import type { InternalBus } from './internal'
import type { Disposable, LoadOptions, PluginDefinition, PluginRecord } from './types'
import { normalizeInject } from './types'

/**
 * 运行时内部的实例记录。
 *
 * 对外的 `PluginRecord` 只描述可观测元数据；调度必需的私有字段挂在这里，
 * 插件与 devtools 拿不到，也就不会依赖到内部实现。
 */
interface InternalRecord extends PluginRecord {
  /** 原始定义：依赖、`provides`、schema 与 `apply` 都以它为准 */
  definition: PluginDefinition
  /** 父上下文；依赖与子插件都挂在这里 */
  parentCtx: Context
  /** 本轮激活的中止控制器；尚未激活过或已回收时为 null */
  abort: AbortController | null
  /** 激活时解析到的依赖实例，用于判断服务身份是否变化 */
  resolved: Map<string, unknown>
}

/**
 * 一条服务授权的记录。
 *
 * 提供权与覆盖权是两个独立授权位：只要 `grant` 过就拥有提供权，
 * `override` 为 true 才允许顶掉同层已有的提供者。
 */
interface GrantEntry {
  /** 是否允许覆盖同层已有的同名服务提供者 */
  override: boolean
}

/**
 * 插件运行时：依赖检查、激活、停用、卸载与调度。
 *
 * 调度采用微任务批处理，避免 apply 内同步创建插件导致递归激活；
 * 服务出现/消失是驱动整个生命周期的唯一信号。
 */
export class PluginRuntime {
  /** 实例 id 的自增后缀；未显式指定 id 时用它拼出 `${name}#${seq}` */
  private seq = 0

  /** 全部已登记实例，键为实例 id；含 pending 与 failed，卸载后才移除 */
  private records = new Map<string, InternalRecord>()

  /** 等待下一微任务批处理的实例 id */
  private queue = new Set<string>()

  /** 所有排队中/执行中的激活任务，供 whenIdle 等待 */
  private pending = new Set<Promise<void>>()

  /** 平台签发的服务授权：pluginId → service → 授权记录 */
  private grants = new Map<string, Map<string, GrantEntry>>()

  /** root 的私有总线；本类订阅 `service`，并向外发 `plugin` 与 `error` */
  private readonly internal: InternalBus

  /**
   * @param app 应用根上下文；私有总线只有一份，因此一个应用只应存在一个 runtime
   *
   * 构造即订阅 `service`：服务的出现与消失是驱动调度的唯一信号，插件在任何时刻
   * `provide` 都不需要再显式通知运行时。监听器与 runtime 同样活到应用结束，不单独注销。
   */
  constructor(private readonly app: Context) {
    this.internal = app.internalBus
    this.internal.on('service', (name, value) => this.onServiceChange(name, value))
  }

  /**
   * 签发服务授权。
   *
   * 生产环境由 loader / createApp 在校验签名与认证等级后调用；
   * 骨架阶段由 bootstrap 为内置服务插件预置。
   *
   * @param pluginId 插件逻辑名（`definition.name`），不是实例 id：`Context.provide`
   * 的授权比对按名字进行，所以同一插件的多个实例共享同一份授权
   * @param names 允许提供的保留服务名；重复签发按名字累积，不会撤销本次未列出的名字
   * @param options `override` 决定能否顶掉同层已有的提供者，缺省只授予提供权
   */
  grant(
    pluginId: string,
    names: readonly string[],
    options: {
      /** 是否同时授予覆盖权；缺省只授予提供权，不能替换已有实现 */
      override?: boolean
    } = {},
  ): void {
    const map = this.grants.get(pluginId) ?? new Map<string, GrantEntry>()
    for (const name of names) {
      map.set(name, { override: Boolean(options.override) })
    }
    this.grants.set(pluginId, map)
  }

  /**
   * 查询插件是否持有某个服务的提供权。
   *
   * @param pluginId 插件逻辑名，须与 `grant` 签发时一致
   * @param needOverride 为 true 时只认覆盖权；提供权与覆盖权是两个独立授权位，
   * 拿到提供权不代表能替换别人已注册的实现
   */
  hasGrant(pluginId: string, name: string, needOverride = false): boolean {
    const entry = this.grants.get(pluginId)?.get(name)
    if (!entry) return false
    return needOverride ? entry.override : true
  }

  /**
   * 加载插件实例并进入调度队列。
   *
   * 返回时只完成登记：这里不检查依赖、不建 Context，`apply` 要等下一微任务批，
   * 所以不能假设调用之后服务就已存在。
   *
   * @param parent 挂载位置的上下文；实例的依赖与子插件都相对它解析
   * @param definition 插件定义
   * @param rawConfig 原始配置；激活时才与 intercept 覆盖合并并过 schema 校验
   * @param options `id` 缺省为 `${name}#${seq}`；同一插件允许有多个实例
   * @returns 状态为 `loading` 的实例记录
   * @throws 实例 id 已存在时抛错
   */
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

    const record = this.buildRecord(parent, definition, id, rawConfig)
    parent.children.add(record)
    this.records.set(id, record)
    this.schedule(id)
    return record
  }

  /**
   * 用定义与挂载位置组装内部记录，状态停留在 `loading`。
   *
   * 只做纯组装、不做登记：id 查重与入队调度留在 `load`，
   * 保证「记录字段」与「运行时表变更」是两个可独立推理的阶段。
   */
  private buildRecord(
    parent: Context,
    definition: PluginDefinition,
    id: string,
    rawConfig: unknown,
  ): InternalRecord {
    return {
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
  }

  /**
   * 卸载插件实例：回收其全部副作用与子插件。
   *
   * 幂等，实例不存在或已卸载时直接返回。记录删除后 id 被释放，同一 id 可以再加载新实例。
   *
   * @throws 无：卸载不做校验，失败的历史状态也会被正常回收
   */
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
   *
   * 只等待已排队与正在执行的激活；因依赖未满足而停在 `pending` 的插件不在追踪范围内，
   * 本方法不会为它一直等下去。
   */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending])
    }
  }

  /**
   * 卸载全部实例（应用销毁时调用）。
   *
   * 逆序（后加载的先卸载）回收，与 `Context.dispose` 处理子插件的顺序一致，
   * 尽量让依赖别人服务的实例先停止。
   */
  dispose(): void {
    for (const record of [...this.records.values()].reverse()) {
      this.unload(record.id)
    }
    this.records.clear()
  }

  /**
   * 重新排队一个停住的实例，供 devtools 与错误面板做「一键重试」。
   *
   * 只接受 `pending` 与 `failed`：这两种状态是「装配没跑成」，重试语义明确。
   * `active` 插件重启会连带重建整棵子树，属于宿主级决策，不由本方法承担。
   * 先广播一次状态变化，界面立刻能看到「正在重试」，而不是等装配完成才有反馈。
   *
   * @param id 插件实例 id
   * @returns 是否已重新排队；实例不存在或状态不允许重试时返回 false
   */
  retry(id: string): boolean {
    const record = this.records.get(id)
    if (!record) return false
    if (record.state !== 'pending' && record.state !== 'failed') return false

    record.error = undefined
    record.state = 'loading'
    this.internal.emit('plugin', record)
    this.schedule(id)
    return true
  }

  /**
   * 可选依赖晚绑定（`ctx.inject` 的实现）。
   *
   * 依赖齐全时创建一个共享 service scope 的子上下文执行 callback；
   * 任一依赖消失时销毁子上下文，但不会让父插件进入 pending。
   * callback 抛错只销毁本轮子上下文并上报诊断，父插件状态不受影响。
   *
   * @param ctx 发起晚绑定的上下文；依赖是否齐全按它的可见性判定
   * @param names 依赖的服务名，全部按「当前可见」比对，不区分必需与可选
   * @param callback 依赖齐全时执行，收到与 ctx 共享服务作用域的子上下文
   * @returns 注销句柄，由 ctx 的 effects 托管；回收时解除订阅并销毁子上下文
   * @throws names 为空时抛错
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

  /**
   * 把实例排入下一微任务批。
   *
   * 批处理是防递归的关键：`apply` 里同步 `ctx.plugin(...)` 时新实例只进队列，
   * 不会再在当前调用栈上激活一轮。
   *
   * @param id 待激活的实例 id
   */
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

  /** 登记在途激活任务，结束后自动摘除；`whenIdle` 依赖这张表判断是否还有活要干。 */
  private track(task: Promise<void>): void {
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
  }

  /**
   * 激活一个实例：依赖检查 → 建新 Context → 解析配置 → 执行 `apply`。
   *
   * 每轮都新建 Context 与 AbortController，上一轮的副作用不会带到这一轮；
   * 依赖变化引起的「重启」走的也是同一条路径。
   *
   * @param id 实例 id；实例已被卸载时静默返回
   */
  private async activate(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) return
    if (this.shouldSkipActivation(record)) return

    // 依赖检查读父上下文，不读自己上次激活残留的服务
    if (!this.dependenciesReady(record)) {
      record.state = 'pending'
      return
    }

    record.resolved = this.resolvedDeps(record)

    const { context, abort } = this.openActivationContext(record)

    let config: unknown
    try {
      config = resolveConfig(record.definition, record.rawConfig, context.collectIntercepts())
    } catch (error) {
      this.fail(record, error, 'config')
      return
    }

    await this.runApply(record, context, config, abort)
  }

  /**
   * 本轮是否无需再激活：进行中（applying）与终态（active / disposing / disposed）都不重入。
   *
   * loading / pending 是等待激活，failed 保留被重新调度的可能，因此这三态都不拦截。
   */
  private shouldSkipActivation(record: InternalRecord): boolean {
    return (
      record.state === 'active' ||
      record.state === 'applying' ||
      record.state === 'disposing' ||
      record.state === 'disposed'
    )
  }

  /** 本轮激活要解析的依赖快照（必需 + 可选）；onServiceChange 据此比对服务身份是否变化 */
  private resolvedDeps(record: InternalRecord): Map<string, unknown> {
    return new Map(
      [...record.inject.required, ...record.inject.optional].map((name) => [
        name,
        record.parentCtx.get(name),
      ]),
    )
  }

  /**
   * 为本次激活新建 Context 与 AbortController，并回填记录上的引用。
   *
   * 每轮激活都是全新实例：上一轮的 effects 与中止信号不会带到这一轮，
   * 依赖变化引起的「重启」走的也是同一条路径。
   *
   * 三处回填缺一不可：`record.context` 供回收、`record.abort` 供 deactivate 中止、
   * `context.record.context` 让从上下文反查实例时拿到本轮而非上一轮。
   * 同时把本轮控制器作为返回值交出：`runApply` 提交状态时要比对的是
   * 「这一轮」的信号，而不是重启后已被替换的 `record.abort`。
   */
  private openActivationContext(record: InternalRecord): {
    /** 本轮新建的服务作用域；同时已回填到 record.context，交出的副本省去调用方再读一次 */
    context: Context
    /** 本轮中止信号；runApply 提交 active 前比对它，拒绝上一轮迟到的 apply 覆盖新一轮状态 */
    abort: AbortController
  } {
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

    return { context, abort }
  }

  /**
   * 装配阶段：进入 `applying`、执行 `apply`、成功则提交 `active`。
   *
   * 失败经 `fail` 上报后落入 `failed`，不向外抛：调度批内一个插件失败
   * 不应中断同批其余实例的激活。
   */
  private async runApply(
    record: InternalRecord,
    context: Context,
    config: unknown,
    abort: AbortController,
  ): Promise<void> {
    record.state = 'applying'
    record.attempts += 1
    const startedAt = Date.now()
    record.activatedAt = startedAt
    try {
      await record.definition.apply(
        context as Context & Parameters<PluginDefinition['apply']>[0],
        config,
      )
      // 异步 apply 期间实例可能已被停用。状态判断挡住「当前已不在装配」，本地 abort 再挡住
      // 「上一轮迟到的 apply 撞上同一实例的新一轮装配」，否则会把已回收的实例标成 active。
      if (record.state !== 'applying' || abort.signal.aborted) return
      record.config = config
      record.applyMs = Date.now() - startedAt
      record.state = 'active'
      this.internal.emit('plugin', record)
    } catch (error) {
      // 与成功路径同一把守卫：异步 apply 期间本轮可能已被停用并开启新一轮装配。
      // 迟到的失败只上报，不能再 deactivate——那会中止新控制器、回收新 Context 并写回 failed。
      if (record.state === 'applying' && !abort.signal.aborted) {
        this.fail(record, error, 'apply')
        return
      }
      this.internal.emit('error', {
        cause: error,
        pluginId: record.id,
        pluginName: record.name,
        phase: 'apply',
      })
    }
  }

  /**
   * 处理服务出现 / 消失，是整个生命周期的唯一驱动入口。
   *
   * 出现：唤醒依赖已齐全的 pending 实例。
   * 消失：让声明了该依赖（必需与可选都算）且解析结果确实变了的实例退回 pending 重建。
   *
   * @param name 发生变化的服务名
   * @param value 变化后的值，undefined 表示消失。事件里的 owner 不予采信：判定一律重新
   * 按父上下文的作用域链取值，避免其他 Realm 注册同名服务被误判成本层变化
   */
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

  /** 必需依赖是否全部可见；可选依赖缺失不阻塞启动。 */
  private dependenciesReady(record: InternalRecord): boolean {
    return record.inject.required.every((name) => record.parentCtx.get(name) !== undefined)
  }

  /**
   * 记录启动失败：先上报 `error`，再把实例打入 `failed`。
   *
   * 顺序有意如此：devtools 收到状态事件时，错误与出错阶段已经可以先于状态落定被读到。
   * 配置阶段失败发生在装配之前，因此不计入 `attempts`。
   *
   * @param phase 失败阶段，决定 devtools 把错误归到「配置校验」还是「插件主体」
   */
  private fail(record: InternalRecord, error: unknown, phase: 'config' | 'apply'): void {
    record.error = error
    // 装配阶段的失败也要留下耗时：devtools 区分「秒失败」与「卡住后被中止」
    if (phase === 'apply' && record.activatedAt !== undefined) {
      record.applyMs = Date.now() - record.activatedAt
    }
    this.internal.emit('error', {
      cause: error,
      pluginId: record.id,
      pluginName: record.name,
      phase,
    })
    this.deactivate(record, 'failed')
  }

  /**
   * 停用实例并回收：中止 → 销毁上下文 → 落入下一个状态。
   *
   * 依赖变化引起的重启、启动失败、显式卸载共用这条路径。
   *
   * @param record 待停用实例；已在回收或已卸载时静默返回
   * @param next 回收后要落到的状态：`pending` 等待重新激活，`failed` 停在失败态
   * @param emit 是否广播 `plugin` 事件；卸载要自己发一次 `disposed`，所以由 unload 关闭它
   */
  private deactivate(record: InternalRecord, next: 'pending' | 'failed', emit = true): void {
    if (record.state === 'disposed' || record.state === 'disposing') return
    // 先置 disposing：回收副作用会同步广播服务消失，onServiceChange 可能重入本方法
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
