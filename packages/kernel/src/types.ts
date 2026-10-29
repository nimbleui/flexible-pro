import type { Context } from './context'

/**
 * 可释放资源。
 *
 * 内核中所有注册（事件、服务、注册表项、UI 贡献、定时器）都必须返回它，
 * 并交给 `ctx.effect` 托管，否则插件卸载后会泄漏。
 */
export interface Disposable {
  dispose(): void
}

/**
 * 插件实例状态。
 *
 * - `loading`：已注册，等待首次调度
 * - `pending`：依赖未满足，尚未执行 apply
 * - `applying`：apply 执行中（可能异步）
 * - `active`：正常运行
 * - `failed`：启动失败，保留错误与配置
 * - `disposing`：正在回收副作用
 * - `disposed`：已卸载
 */
export type PluginState =
  'loading' | 'pending' | 'applying' | 'active' | 'failed' | 'disposing' | 'disposed'

/**
 * 插件的服务依赖声明。
 */
export interface Inject {
  /** 必需依赖：全部存在才会启动 */
  required: string[]
  /** 可选依赖：缺失不阻塞启动，但服务身份变化时仍会触发停用重建 */
  optional: string[]
}

/**
 * 插件配置的校验器。
 *
 * 只需实现 `parse`，返回带默认值的完整配置；zod schema 天然满足该接口。
 * `toJSONSchema` 供 devtools / 低代码配置面板展示，内核不消费。
 */
export interface ConfigSchema<S> {
  /** 校验并返回带默认值的配置；抛错视为配置阶段失败 */
  parse(input: unknown): S
  /** 返回配置的 JSON Schema 描述，可选 */
  toJSONSchema?(): unknown
}

/**
 * 插件定义：纯数据 + 一个 apply。
 *
 * `apply` 只在依赖满足时调用，每次激活调用一次；`C` 可收窄为
 * `EditorContext` / `CanvasContext`，由 contracts 提供类型糖。
 */
export interface PluginDefinition<S = unknown, C extends Context = Context> {
  /** 插件逻辑名，必须与 manifest.name 一致，用于冲突提示与调试 */
  name: string
  /** 服务依赖；可用字符串数组简写为「全部必需」 */
  inject?: string[] | Inject
  /** 声明会提供的服务名；仅用于静态依赖图与构建期校验 */
  provides?: string[]
  /** 配置 schema；省略时原样透传合并后的配置 */
  schema?: ConfigSchema<S>
  /** 插件主体；依赖满足时执行 */
  apply(ctx: C, config: S): void | Promise<void>
}

/**
 * 一个插件实例的元数据。
 *
 * 同一插件可以有多实例，因此 `id` 才是唯一键，`name` 不是。
 */
export interface PluginRecord<S = unknown> {
  /** 实例 id；缺省为 `${name}#${seq}` */
  id: string
  /** 插件逻辑名 */
  name: string
  /** 当前状态 */
  state: PluginState
  /** 用户传入的原始配置，重启/热重载时复用 */
  rawConfig: unknown
  /** 校验并合并后的配置，仅在激活期间存在 */
  config?: S
  /** 当前实例上下文；停用后置空 */
  context: Context | null
  /** 父实例；根插件为 null */
  parent: PluginRecord | null
  /** 解析后的依赖 */
  inject: Inject
  /** 声明的服务名 */
  provides: string[]
  /** 启动失败的错误 */
  error?: unknown
  /** 启动尝试次数，用于诊断与退避 */
  attempts: number
}

/** 加载插件时的选项。 */
export interface LoadOptions {
  /** 显式指定实例 id；同一 id 重复加载会抛错 */
  id?: string
}

/** 创建隔离作用域时的选项。 */
export interface ForkOptions {
  /** 只允许列出的服务穿透到本作用域；省略表示不限制 */
  filter?: string[]
}

/** 事件监听选项。 */
export interface EventOptions {
  /** 是否插到同类监听器最前；优先于 priority */
  prepend?: boolean
  /** 同优先级分组内的排序值，越大越先执行 @default 0 */
  priority?: number
}

/**
 * 类型化事件表。
 *
 * 内核只声明空接口，业务事件通过 declaration merging 扩展
 * （集中定义在 `@lc/contracts`，插件不得各自扩展）。
 */
export interface Events {}

/** 恒等函数：统一插件入口，负责配置类型推断。 */
export function definePlugin<S>(definition: PluginDefinition<S>): PluginDefinition<S> {
  return definition
}

/** 把 `inject` 的两种写法归一化为结构体。 */
export function normalizeInject(inject?: string[] | Inject): Inject {
  if (!inject) return { required: [], optional: [] }
  if (Array.isArray(inject)) return { required: [...inject], optional: [] }
  return { required: [...inject.required], optional: [...inject.optional] }
}
