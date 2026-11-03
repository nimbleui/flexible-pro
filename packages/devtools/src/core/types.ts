import type { Context, DispatchMode, PluginState } from '@lc/kernel'
import type { CertificationTier, ExecutionProfile } from '@lc/contracts'

/** 应用根作用域的固定 id；面板选中态依赖它保持稳定。 */
export const ROOT_SCOPE_ID = 'root'

/** 事件日志保留条数：够看清一段操作序列，又不会让面板吃掉无界内存。 */
export const EVENT_LOG_LIMIT = 500

/** 一个可自省的服务作用域。 */
export interface DevtoolsScope {
  /** 稳定 id；根为 `root`，Realm 用 realm id，画布层由所属 Realm 派生 */
  id: string
  /** 展示名 */
  label: string
  /** 该作用域的上下文；服务与插件都从这里取 */
  context: Context
  /** 父作用域 id；根为 null */
  parentId: string | null
}

/** 清单摘要；未登记 manifest 的内置插件只有名字，没有这些字段。 */
export interface ManifestSummary {
  /** 展示名，缺省时等于 name */
  displayName?: string
  /** 语义化版本 */
  version?: string
  /** 认证等级 @default 'community' */
  certification?: CertificationTier
  /** 执行位置 @default 'inline' */
  executionProfile?: ExecutionProfile
  /** 是否已被 loader 激活（纯声明式插件始终为 false） */
  activated: boolean
  /** 声明式贡献条目数，按贡献类型分组 */
  contributions: readonly ContributionCount[]
}

/** 一类贡献的条目数。 */
export interface ContributionCount {
  /** 贡献类型，如 `panels`、`canvasFeatures` */
  kind: string
  /** 条目数 */
  count: number
}

/** 插件树的一行。 */
export interface PluginRow {
  /** 实例 id，唯一键 */
  id: string
  /** 插件逻辑名 */
  name: string
  /** 所属作用域 id */
  scopeId: string
  /** 树深度；作用域直属插件为 0 */
  depth: number
  /** 父实例 id；作用域直属为 null */
  parentId: string | null
  /** 当前状态 */
  state: PluginState
  /** 必需依赖 */
  required: readonly string[]
  /** 可选依赖 */
  optional: readonly string[]
  /** 当前解析不到的必需依赖；active 时为空 */
  missing: readonly string[]
  /** 声明会提供的服务 */
  provides: readonly string[]
  /** 实际注册在本作用域服务表里的服务 */
  owned: readonly string[]
  /** 装配尝试次数 */
  attempts: number
  /** 进入装配的时间戳（毫秒） */
  activatedAt?: number
  /** 上一次装配耗时（毫秒） */
  applyMs?: number
  /** 展平后的错误文本 */
  error?: string
  /** 清单摘要；未登记清单时不存在 */
  manifest?: ManifestSummary
}

/** 服务表的一行：某个作用域里实际注册的一条服务。 */
export interface ServiceRow {
  /** 服务名 */
  name: string
  /** 注册所在作用域 id */
  scopeId: string
  /** 提供者实例 id */
  ownerId: string
  /** 提供者插件名 */
  ownerName: string
  /** 契约版本 */
  apiVersion: string
  /** 是否平台保留服务 */
  reserved: boolean
  /** 值的可读摘要，用于认出是哪一个实现 */
  summary: string
  /** 遮蔽链：第一项是本作用域实际取到的提供者，其余是被它盖住的下层 */
  chain: readonly ServiceChainLink[]
}

/** 遮蔽链上的一层。 */
export interface ServiceChainLink {
  /** 该层所属作用域 id；不在自省范围内的层为 null */
  scopeId: string | null
  /** 作用域展示名 */
  scopeLabel: string
  /** 提供者实例 id */
  ownerId: string
  /** 提供者插件名 */
  ownerName: string
  /** 契约版本 */
  apiVersion: string
  /** 是否是本作用域实际解析到的那一层 */
  active: boolean
}

/** 依赖关系的一条边。 */
export interface DependencyEdge {
  /** 需求方实例 id */
  from: string
  /** 需求方插件名 */
  fromName: string
  /** 需求方所在作用域 */
  scopeId: string
  /** 依赖的服务名 */
  service: string
  /** 是否必需依赖 */
  required: boolean
  /** 实际提供者实例 id；无人提供为 null */
  to: string | null
  /** 实际提供者插件名 */
  toName: string | null
}

/** 一个停住的插件与它卡住的原因。 */
export interface BlockedPlugin {
  /** 实例 id */
  id: string
  /** 插件名 */
  name: string
  /** 所属作用域 */
  scopeId: string
  /** 当前状态 */
  state: PluginState
  /** 缺失的必需依赖 */
  missing: readonly string[]
  /** 装配阶段失败的原因 */
  error?: string
  /** 每个缺失服务的候选提供者 */
  candidates: readonly MissingServiceCandidate[]
}

/** 缺失服务的候选提供者。 */
export interface MissingServiceCandidate {
  /** 服务名 */
  service: string
  /**
   * 声明了该服务的所有已登记实例，并带上各自还缺什么。
   *
   * 为空说明没有任何已加载插件声明提供这个服务；提供者自己也在等，就是连锁阻塞。
   */
  providers: readonly BlockedProvider[]
  /**
   * 只出现在清单里、尚未加载的插件名。
   *
   * 这类插件没有实例记录，光看插件树找不到它们；但「依赖的插件压根没激活」
   * 恰恰是 pending 最常见的原因，所以按 `manifest.provides` 单独列出来。
   */
  unactivated: readonly string[]
}

/** 候选提供者实例。 */
export interface BlockedProvider {
  /** 实例 id */
  id: string
  /** 插件名 */
  name: string
  /** 该提供者自己还缺什么；非空说明是连锁阻塞 */
  missing: readonly string[]
}

/** 依赖视图：边、阻塞点与环。 */
export interface DependencyView {
  /** 全部依赖边 */
  edges: readonly DependencyEdge[]
  /** 停在 pending / failed 的插件 */
  blocked: readonly BlockedPlugin[]
  /** 互相等待的实例 id 环；内核不求解依赖图，这里只负责把它显示出来 */
  cycles: readonly (readonly string[])[]
}

/** 配置的来源片段。 */
export interface ConfigOverride {
  /** 覆盖所在作用域 */
  scopeId: string
  /** 作用域展示名 */
  label: string
  /** 覆盖片段 */
  patch: object
}

/** 单个插件实例的配置视图。 */
export interface PluginConfigView {
  /** 实例 id */
  id: string
  /** 插件名 */
  name: string
  /** 宿主传入的原始配置 */
  raw: unknown
  /** 合并与校验后的配置；只有激活期间存在，未启动与已停用都是空 */
  resolved: unknown
  /** 从根到本层生效的 intercept 覆盖 */
  overrides: readonly ConfigOverride[]
}

/** 一条事件日志。 */
export interface EventLogEntry {
  /** 自增序号，用于稳定排序与虚拟列表 key */
  seq: number
  /** 记录时间戳（毫秒） */
  at: number
  /** 事件名 */
  name: string
  /** 分发模式 */
  mode: DispatchMode
  /** 执行该监听器的插件实例 id */
  pluginId?: string
  /** 监听器自身耗时（毫秒） */
  duration: number
  /** 本次分发的监听器总数 */
  listenerCount: number
  /** 监听器抛错时的错误文本 */
  error?: string
}

/** 画布视图快照。 */
export interface CanvasView {
  /** 视口状态 */
  viewport: {
    /** 左上角世界坐标 x */
    x: number
    /** 左上角世界坐标 y */
    y: number
    /** 缩放倍数 */
    zoom: number
    /** 旋转弧度 */
    rotation: number
    /** 可视区宽度（屏幕像素） */
    width: number
    /** 可视区高度（屏幕像素） */
    height: number
  }
  /** 场景图 */
  scene: {
    /** 登记节点数 */
    count: number
    /** 登记顺序（底 → 顶）；引用服务内部的登记数组，不做副本，消费方不得修改 */
    order: readonly string[]
    /** 文档根包围盒 */
    rootBounds: {
      /** 左上角 x，画布世界坐标（非 CSS 像素；屏幕像素 = 世界值 × zoom） */
      x: number
      /** 左上角 y，画布世界坐标 */
      y: number
      /** 世界坐标系下的宽度，与 x/y 同一坐标空间 */
      width: number
      /** 世界坐标系下的高度 */
      height: number
    }
  }
  /** 覆盖层 */
  layers: readonly {
    /** 图层 id */
    id: string
    /** 图层带 */
    band: string
    /** 同带内排序 */
    zIndex: number
    /** 指针行为 */
    pointerEvents: string
  }[]
  /** 交互处理器 */
  handlers: readonly {
    /** 处理器 id */
    id: string
    /** 命中阶段 */
    phase: string
    /** 同阶段优先级 */
    priority: number
  }[]
  /** 选中集 */
  selection: {
    /** 选中 id */
    ids: readonly string[]
    /** 主选中 */
    primary: string | null
  }
  /** 隐藏 / 锁定集合 */
  flags: {
    /** 隐藏节点 id */
    hidden: readonly string[]
    /** 锁定节点 id */
    locked: readonly string[]
  }
  /** 文档信息；无文档服务时为 null */
  document: {
    /** 文档 id */
    id: string
    /** 文档标题 */
    title: string
    /** schema 架构版本 */
    schemaVersion: string
    /** 文档递增版本号 */
    revision: number
    /** 节点数 */
    nodeCount: number
    /** 是否有未保存变更 */
    dirty: boolean
  } | null
  /** 撤销/重做 */
  history: {
    /** 可撤销 */
    canUndo: boolean
    /** 可重做 */
    canRedo: boolean
    /** 条目数 */
    count: number
  } | null
}
