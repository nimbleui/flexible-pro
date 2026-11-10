import type {
  ContributionItem,
  ContributionPoint,
  ContributionService,
  ContributionValueMap,
  LoaderService,
  PluginPackage,
} from '@lc/contracts'
import { definePlugin } from '@lc/kernel'
import type { Disposable, PluginDefinition, PluginRecord } from '@lc/kernel'

/** 贡献注册表内部存储条目 */
interface StoredContribution {
  /** 贡献来源插件名，同时是排序的最后一级键 */
  plugin: string

  /** 贡献点名，决定读取时收窄到哪个值类型 */
  point: ContributionPoint

  /** 原始贡献对象；order / priority 就从这里动态读取 */
  value: ContributionValueMap[ContributionPoint]

  /** 登记序号，用于追溯登记次序；当前排序未使用它 */
  seq: number
}

/**
 * 排序时从贡献对象动态读取的元数据。
 *
 * 并非所有贡献点都声明这两个字段，因此缺失一律按 0 处理；
 * 两字段排序方向相反，不能混用。
 */
interface ContributionMeta {
  /** 位置序号，同点内升序 @default 0 */
  order?: number

  /** 同 order 分组内的优先级，降序 @default 0 */
  priority?: number
}

/**
 * 面板贡献的插槽字段形状。
 *
 * slot 是 panels 贡献点自己的字段而不是通用维度，因此鸭子读取只发生在这里。
 */
interface PanelSlotHint {
  /** 归属插槽名；未声明的面板不出现在任何插槽 */
  slot?: string
}

/**
 * 已加载模块的导出别名形状。
 *
 * 模块是外部构建产物，运行时只能鸭子判断，两种别名兼容历史导出习惯。
 */
interface PluginModuleNamespace {
  /** 首选导出：ES Module 的 default */
  default?: unknown

  /** 备选导出：`export const plugin = ...` 的写法 */
  plugin?: unknown
}

/** apply 字段探测形状；值为函数即视为插件定义 */
interface ApplyProbe {
  /** 插件主体函数；此处只验「是不是函数」，签名正确性交给激活阶段 */
  apply: unknown
}

/**
 * 声明式贡献注册表。
 *
 * 存储层是异构数组，读取时按 point 泛型收窄；排序统一为
 * order 升序 → priority 降序 → 插件名，保证多插件来源稳定可复现。
 */
function createContributionRegistry(): ContributionService {
  const items: StoredContribution[] = []
  const listeners = new Set<() => void>()
  let seq = 0

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  /**
   * 按 order 升序 → priority 降序 → 插件名排序。
   *
   * order / priority 是从贡献对象上动态读的，缺失按 0 处理；三者全同时依赖
   * Array.sort 的稳定性落到登记先后，因此同插件同权重的贡献顺序等于注册顺序。
   */
  function sorted(list: StoredContribution[]): StoredContribution[] {
    return [...list].sort((a, b) => {
      const aMeta = a.value as ContributionMeta
      const bMeta = b.value as ContributionMeta
      const orderDiff = (aMeta.order ?? 0) - (bMeta.order ?? 0)
      if (orderDiff !== 0) return orderDiff
      const priorityDiff = (bMeta.priority ?? 0) - (aMeta.priority ?? 0)
      if (priorityDiff !== 0) return priorityDiff
      return a.plugin.localeCompare(b.plugin)
    })
  }

  return {
    /**
     * 批量登记某个贡献点的条目。
     *
     * 一次登记返回一个 Disposable 撤掉整批，插件不必逐条持有；
     * 同 id 的贡献允许重复出现，注册表不去重，由消费方按 id 自行处理。
     */
    register(plugin, point, entries) {
      const batch = entries.map((value) => ({
        plugin,
        point,
        value: value as ContributionValueMap[ContributionPoint],
        seq: ++seq,
      }))
      items.push(...batch)
      notify()

      return {
        dispose: () => {
          for (const entry of batch) {
            const index = items.indexOf(entry)
            if (index >= 0) items.splice(index, 1)
          }
          notify()
        },
      }
    },

    /** 取某个贡献点的全部条目；每次调用都重新过滤排序，不做结果缓存 */
    list<K extends ContributionPoint>(point: K): readonly ContributionItem<K>[] {
      return sorted(items.filter((item) => item.point === point)).map((item) => ({
        plugin: item.plugin,
        point,
        value: item.value as ContributionValueMap[K],
      }))
    },

    /**
     * 按插槽名取面板贡献。
     *
     * 只筛 `panels` 一个贡献点，slot 是面板自己的字段而不是通用维度，
     * 因此没有做成 list(point, filter) 以免把过滤协议扩散到所有贡献点。
     * 未声明 slot 的面板不会出现在任何插槽里。
     */
    listSlot(slot) {
      const panels = items.filter(
        (item) => item.point === 'panels' && (item.value as PanelSlotHint).slot === slot,
      )
      return sorted(panels).map((item) => ({
        plugin: item.plugin,
        point: 'panels' as const,
        value: item.value as ContributionValueMap['panels'],
      }))
    },

    onDidChange(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }
}

/**
 * 校验清单必填项。
 *
 * 在登记阶段就抛错，而不是等到激活时才因缺字段失败：清单是安装期数据，
 * 越早拒绝越能让上层安装流程给出准确提示。
 */
function assertManifest(pkg: PluginPackage): void {
  const { manifest } = pkg
  if (!manifest.name) throw new Error('[loader] manifest 缺少 name')
  if (!manifest.version) throw new Error(`[loader] manifest "${manifest.name}" 缺少 version`)
  if (!manifest.engines?.lowcode) {
    throw new Error(`[loader] manifest "${manifest.name}" 缺少 engines.lowcode`)
  }
}

/**
 * 从已加载模块里取出插件定义。
 *
 * 模块是外部构建产物，运行时只能用鸭子类型判断（有 apply 函数即视为定义），
 * 同时兼容 default 与 plugin 两种导出别名。取不到时返回 undefined，
 * 由调用方转成诊断记录，而不是在这里抛错打断整条加载链。
 */
function extractDefinition(module: unknown): PluginDefinition | undefined {
  if (typeof module !== 'object' || module === null) return undefined
  const namespace = module as PluginModuleNamespace
  const candidate = namespace.default ?? namespace.plugin
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'apply' in candidate &&
    typeof (candidate as ApplyProbe).apply === 'function'
  ) {
    return candidate as PluginDefinition
  }
  return undefined
}

/**
 * 收集 manifest 中声明的模块（去重），用于登记到 ModuleService。
 *
 * 只覆盖带 module 字段的三类贡献；同一 module 被多条贡献引用时只登记一次，
 * 共享同一份加载结果。
 */
function collectModules(pkg: PluginPackage): string[] {
  const contributes = pkg.manifest.contributes
  if (!contributes) return []

  const modules = new Set<string>()
  for (const item of contributes.materials ?? []) modules.add(item.module)
  for (const item of contributes.panels ?? []) modules.add(item.module)
  for (const item of contributes.canvasFeatures ?? []) modules.add(item.module)
  return [...modules]
}

/**
 * 装载器插件：清单登记、声明式贡献注册、按激活事件加载插件代码。
 *
 * 安装 ≠ 启用：`register` 只注册元数据与贡献；`ensureActivated` 命中
 * 激活事件后才 `import()` 并 `ctx.plugin`。`onCanvasFeature:*` 由
 * CanvasHost 按文档实例化，装载器只负责提供模块加载能力。
 */
export default definePlugin({
  name: 'service-loader',
  inject: ['modules'],
  provides: ['loader', 'contribution'],

  apply(ctx) {
    const contribution = createContributionRegistry()
    ctx.effect(() => ctx.provide('contribution', contribution, { apiVersion: '1.0' }))

    /** 插件名 → 已登记的包 */
    const packages = new Map<string, PluginPackage>()

    /** 插件名 → 登记时产生的贡献与模块 Disposable，撤销登记时整体回收 */
    const registrations = new Map<string, Disposable[]>()

    /** 插件名 → 已激活实例记录，同时也是「已激活」的唯一判据 */
    const activated = new Map<string, PluginRecord>()
    /** 插件名 → 在途激活；在 await pkg.load() 之前登记，并发触发时共享同一个 Promise */
    const pending = new Map<string, Promise<void>>()
    const listeners = new Set<() => void>()

    function notify(): void {
      for (const listener of [...listeners]) listener()
    }

    /**
     * 加载并激活一个插件。
     *
     * 并发安全：在 `await pkg.load()` 之前登记同一个 Promise，并行触发同一插件时后到的
     * 调用直接复用，不会二次 ctx.plugin。撤销登记后回来的任务靠 packages 表判活，
     * 不会把已撤销的插件挂回失效的作用域。
     * 没有 main 的纯声明式插件不激活，也不会被记进 activated，所以每次激活事件
     * 都会走到这里再快速返回。
     *
     * 失败不向上抛：清单名与定义名不一致、模块加载异常都只记诊断并发
     * `plugin:failed`，一个坏插件不应中断其余插件的激活流程。
     */
    async function activate(pkg: PluginPackage): Promise<void> {
      const { manifest } = pkg
      if (activated.has(manifest.name)) return

      // 纯声明式插件没有 main：模块由渲染器按贡献懒加载，不激活 apply
      if (!manifest.main) return

      const inflight = pending.get(manifest.name)
      if (inflight) return inflight

      // 包一层微任务，保证 pkg.load() 同步抛错时 finally 也在 pending.set 之后执行
      const task = Promise.resolve().then(async () => {
        try {
          const module = await pkg.load()
          // 加载期间可能已被撤销登记或应用已销毁，此时不能再装配
          if (!packages.has(manifest.name) || ctx.signal.aborted) return
          const definition = extractDefinition(module)
          if (!definition) {
            throw new Error(`[loader] 插件 "${manifest.name}" 未导出插件定义`)
          }
          if (definition.name !== manifest.name) {
            throw new Error(
              `[loader] manifest.name "${manifest.name}" 与 definition.name "${definition.name}" 不一致`,
            )
          }

          const record = ctx.plugin(definition as PluginDefinition)
          activated.set(manifest.name, record)
          ctx.emit('plugin:activated', { plugin: manifest.name, instanceId: record.id })
        } catch (error) {
          ctx.diagnostics.report(error, { scope: 'loader', plugin: manifest.name })
          ctx.emit('plugin:failed', { plugin: manifest.name, error })
        } finally {
          // 只删自己的登记：撤销后重新登记同名插件会写入新任务，旧任务不能把它删掉
          if (pending.get(manifest.name) === task) pending.delete(manifest.name)
          notify()
        }
      })

      pending.set(manifest.name, task)
      return task
    }

    const service: LoaderService = {
      /**
       * 登记一个已安装的插件包。
       *
       * 只做三件事：写清单表、把 contributes 逐点注册进贡献表、把贡献声明的模块
       * 注册进 ModuleService（key 为 `插件名/模块路径`，必须与 material 等消费方
       * 的 moduleKey 拼法一致）。此过程不加载任何代码。
       *
       * @throws 清单必填项缺失，或同名插件已登记时抛错。
       */
      register(pkg): Disposable {
        assertManifest(pkg)
        const { manifest } = pkg
        if (packages.has(manifest.name)) {
          throw new Error(`[loader] 插件重复登记: ${manifest.name}`)
        }

        packages.set(manifest.name, pkg)
        const disposables: Disposable[] = []
        const contributes = manifest.contributes ?? {}

        for (const point of Object.keys(contributes) as ContributionPoint[]) {
          const entries = contributes[point as keyof typeof contributes]
          if (!Array.isArray(entries) || entries.length === 0) continue
          disposables.push(
            contribution.register(
              manifest.name,
              point,
              entries as ContributionValueMap[ContributionPoint][],
            ),
          )
        }

        for (const module of collectModules(pkg)) {
          disposables.push(
            ctx.modules.register({
              key: `${manifest.name}/${module}`,
              load: pkg.load,
            }),
          )
        }

        registrations.set(manifest.name, disposables)
        notify()

        return {
          /**
           * 撤销登记：逆序释放贡献与模块注册，再卸载已激活的实例。
           *
           * 记录在 root runtime 里，因此卸载走 `ctx.root.runtime.unload`；
           * evict 按插件名前缀清掉该插件的全部模块缓存，重装时不会复用旧模块。
           */
          dispose: () => {
            for (const disposable of [...(registrations.get(manifest.name) ?? [])].reverse()) {
              disposable.dispose()
            }
            registrations.delete(manifest.name)

            // 摘掉在途任务：回来后靠 packages 表判活，同名插件重新登记也能重新激活
            pending.delete(manifest.name)
            const record = activated.get(manifest.name)
            if (record) ctx.root.runtime.unload(record.id)
            activated.delete(manifest.name)
            ctx.modules.evict(manifest.name)
            packages.delete(manifest.name)
            notify()
          },
        }
      },

      /** 已登记插件的清单快照，顺序即登记顺序（不按 order 排序，那是贡献表的事） */
      scan() {
        return [...packages.values()].map((pkg) => pkg.manifest)
      },

      get(name) {
        return packages.get(name)
      },

      /**
       * 触发一个激活事件。
       *
       * 多个插件并行加载；同一插件的并发触发由 activate 的 pending 表合并为一次装配。
       * 未匹配到任何插件时静默返回，事件名拼错不会有反馈。
       *
       * @param event 与 manifest.activationEvents 全等匹配的字符串
       */
      async ensureActivated(event) {
        // 画布能力必须挂到 CanvasRealm，不能在此激活
        if (event.startsWith('onCanvasFeature:')) return

        const targets = [...packages.values()].filter((pkg) =>
          pkg.manifest.activationEvents?.includes(event),
        )
        await Promise.all(targets.map((pkg) => activate(pkg)))
      },

      isActivated(plugin) {
        return activated.has(plugin)
      },

      /** 登记与激活都会通知；监听者只被告知「变了」，具体变了什么要自己重新 scan */
      onDidChange(listener) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
    }

    ctx.effect(() => ctx.provide('loader', service, { apiVersion: '1.0' }))
  },
})
