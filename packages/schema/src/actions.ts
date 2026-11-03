/**
 * 事件与动作协议（对应《Schema 与物料协议》§2.8）
 * ---
 * 低代码平台不能把 `onClick` 函数存进 Schema：函数无法安全序列化，也不便于版本迁移、
 * 审计与可视化编辑。这里采用「事件连接 + 动作定义」两步：
 *  - `EventConnection` 只描述「哪个节点的哪个事件，按顺序执行哪些动作」；
 *  - `ActionDeclaration` 独立成集合，由 id 被连接引用，便于复用与单独迁移。
 *
 * 顺序即执行顺序（`actionIds` 的数组顺序），分支由 `flow.condition` 动作表达，
 * 因此不需要图结构：一张「事件流」在数据上就是一条动作序列。
 *
 * ## 分支语义：if/else，不是 goto
 *
 * `flow.condition` 执行完选中分支后**回到原链继续执行后续动作**，与语句级 if/else 一致。
 * 曾经有两种可选语义，选这一种的原因：
 *  - 「跳转后不再回来」会让一条链的实际执行顺序无法从 `actionIds` 数组读出，
 *    面板上排的顺序与真实执行顺序不一致，调试时无从对照；
 *  - 需要提前终止的场景由显式的 `flow.end` 表达，读 schema 就能看出链在哪里断。
 *
 * ## 动作之间的引用
 *
 * 控制流动作会引用其他动作 id（分支目标、序列成员），失败策略 `fallback` 也会。
 * 这些引用统一由 {@link referencedActionIds} 提取，供校验做悬空引用检查与环检测。
 * 插件自定义的动作若在自己的 `config` 里引用动作 id，本函数无法感知——因此执行器
 * 另有步数上限兜底，环检测不是唯一防线。
 */

import type { ExpressionString } from './expression'

/**
 * 动作声明。
 *
 * 一个可序列化的原子操作；`type` 决定 `config` 的结构与执行器。
 */
export interface ActionDeclaration {
  /** 动作唯一标识（在页面内唯一），同时作为 `PageSchema.actions` 的键 */
  id: string
  /** 动作类型，内置类型见 `BUILTIN_ACTIONS`；插件可注册自定义类型 */
  type: string
  /** 画布/面板上的显示名（可选），缺省取内置类型标题 */
  name?: string
  /** 动作配置；字段随 `type` 而定，只允许 JSON 可序列化值 */
  config: Record<string, unknown>
  /**
   * 执行条件（可选）：求值为假时**跳过本动作，继续执行后续动作**。
   *
   * 跳过不等于失败，因此不触发 `onError`。求值本身抛错时按失败处理，
   * 因为「条件写错了」与「条件为假」必须可区分，否则表达式里的拼写错误
   * 会静默变成一条永远不执行的分支。
   */
  condition?: ExpressionString
  /**
   * 失败策略（可选）。
   *
   * - `stop`：中断整条事件流（默认）
   * - `continue`：忽略本次失败，继续执行后续动作
   * - `fallback`：转而执行 {@link ActionDeclaration.fallbackActionId} 指定的补救动作，
   *   补救动作执行完同样回到原链继续
   *
   * @default 'stop'
   */
  onError?: ActionErrorStrategy
  /**
   * 补救动作 id；仅当 `onError === 'fallback'` 时有意义。
   *
   * 放在动作顶层而不是塞进 `config`：它是失败策略的一部分，与动作类型无关，
   * 且校验需要无条件检查这个引用是否悬空——藏在 `config` 里就得先知道每种
   * 动作类型的 config 形状才能校验。
   */
  fallbackActionId?: string
}

/** 动作失败后的处置方式 */
export type ActionErrorStrategy = 'stop' | 'continue' | 'fallback'

/**
 * 事件连接。
 *
 * 描述「某个节点的某个事件 → 一串按序执行的动作」。
 */
export interface EventConnection {
  /** 连接唯一标识，同时作为 `PageSchema.connections` 的键 */
  id: string
  /**
   * 触发事件的节点 id。
   *
   * 页面级事件（如页面加载）没有具体节点，统一用 {@link PAGE_EVENT_SOURCE} 占位；
   * 用哨兵值而不是再造一个 `scope` 字段，是因为「来源只有一个」这件事不该由两个字段
   * 共同表达——两者不一致时校验也无从判断谁对。
   */
  sourceNodeId: string
  /**
   * 事件名。
   *
   * 节点事件取自物料的 `ComponentSchema.events` 声明，页面级事件取自 {@link PAGE_EVENTS}。
   * 组件生命周期若需要被绑定，同样由物料声明成普通事件走这条路径。
   */
  eventName: string
  /** 按顺序执行的动作 id 列表；空数组表示「事件已绑定但暂不执行任何动作」 */
  actionIds: string[]
  /** 是否启用；停用后保留配置但不执行 */
  enabled: boolean
}

/** 页面级事件连接的来源节点哨兵值 */
export const PAGE_EVENT_SOURCE = 'page'

/** 页面级事件名；与节点事件共用 {@link EventConnection.eventName} */
export const PAGE_EVENTS = ['pageLoad', 'pageUnload'] as const

/** 页面级事件名 */
export type PageEventName = (typeof PAGE_EVENTS)[number]

/** 控制流动作类型；这些类型的 `config` 里含动作 id 引用，见 {@link referencedActionIds} */
export const FLOW_CONDITION = 'flow.condition'
export const FLOW_SEQUENCE = 'flow.sequence'
export const FLOW_END = 'flow.end'

/**
 * 内置动作的配置字段描述。
 *
 * 只描述「渲染表单需要什么」，不含执行逻辑：执行器由运行时提供，协议层不依赖 DOM 或请求。
 */
export interface ActionFieldSchema {
  /** 配置键名 */
  key: string
  /** 表单标题 */
  label: string
  /** 控件形态，与属性面板的 setter 分类对齐 */
  kind: ActionFieldKind
  /** 是否必填 */
  required?: boolean
  /**
   * `select` 的候选项；仅 `kind === 'select'` 时被表单读取。
   *
   * 候选值固定为字符串：动作 config 整体是 JSON，执行器拿到的就是这份文本，
   * 协议层不做数字转换，避免「表单里是 300、config 里存 "300"」这类隐性差异。
   */
  options?: ReadonlyArray<{
    /** 写入动作 config 的值 */
    value: string
    /** 选项在表单里的展示名 */
    label: string
  }>
  /** 占位提示 */
  placeholder?: string
}

/**
 * 配置字段的控件形态。
 *
 * `action` 是「从本页动作表里选一个」的下拉，而不是自由文本：分支目标写错一个字符
 * 就会静默变成不执行的分支，必须让面板只允许选已存在的动作。
 *
 * `expression` 与 `text` 的差别只在面板用哪个编辑器，执行器一律解析。但校验会额外
 * 要求它的值是真正的表达式对象：条件位置上的裸文本永远为真，是个不会报错但行为
 * 完全不对的陷阱，必须设计期拦下（见 `validate.ts` 的 `checkExpressionFields`）。
 */
export type ActionFieldKind =
  'text' | 'number' | 'select' | 'toggle' | 'json' | 'action' | 'expression'

/** 内置动作的元数据 */
export interface ActionDefinition {
  /** 动作类型标识 */
  type: string
  /** 显示名 */
  title: string
  /** 一句话说明，用于动作选择器 */
  description: string
  /** 配置字段；空数组表示该动作无需配置 */
  fields: readonly ActionFieldSchema[]
}

/**
 * 内置动作清单（协议 §2.8 建议项 + `flow.end`）。
 *
 * 每种动作都必须有独立的参数描述；`plugin.invoke` 只按声明调用插件服务，
 * 不允许直接访问插件内部对象，因此它的配置里只有服务名与方法名。
 */
export const BUILTIN_ACTIONS: readonly ActionDefinition[] = [
  {
    type: 'state.set',
    title: '更新状态',
    description: '写入页面状态变量；表达式里按 data.<变量名> 读取',
    fields: [
      { key: 'key', label: '变量名', kind: 'text', required: true, placeholder: '如 keyword' },
      {
        key: 'value',
        label: '值',
        kind: 'text',
        required: true,
        placeholder: '支持 {{ }} 表达式',
      },
    ],
  },
  {
    type: 'state.reset',
    title: '重置状态',
    description: '恢复状态初始值',
    fields: [{ key: 'key', label: '变量名', kind: 'text', placeholder: '留空则重置全部' }],
  },
  {
    type: 'dataSource.fetch',
    title: '获取数据',
    description: '触发已注册数据源',
    fields: [
      { key: 'dataSourceId', label: '数据源', kind: 'text', required: true },
      { key: 'assignTo', label: '结果变量', kind: 'text', placeholder: '如 list' },
    ],
  },
  {
    type: 'navigation.go',
    title: '页面跳转',
    description: '受控路由跳转',
    fields: [
      { key: 'to', label: '目标路径', kind: 'text', required: true, placeholder: '/detail/1' },
      { key: 'replace', label: '替换历史', kind: 'toggle' },
    ],
  },
  {
    type: 'ui.toast',
    title: '显示消息',
    description: '弹出提示',
    fields: [
      { key: 'message', label: '内容', kind: 'text', required: true },
      {
        key: 'level',
        label: '级别',
        kind: 'select',
        options: [
          { value: 'info', label: '提示' },
          { value: 'success', label: '成功' },
          { value: 'warning', label: '警告' },
          { value: 'error', label: '错误' },
        ],
      },
    ],
  },
  {
    type: FLOW_CONDITION,
    title: '条件分支',
    description: '按表达式结果执行其中一条分支，之后继续原链',
    fields: [
      {
        key: 'expression',
        label: '条件',
        kind: 'expression',
        required: true,
        placeholder: '{{ count > 0 }}',
      },
      { key: 'trueActionId', label: '成立时执行', kind: 'action' },
      { key: 'falseActionId', label: '不成立时执行', kind: 'action' },
    ],
  },
  {
    type: FLOW_SEQUENCE,
    title: '顺序执行',
    description: '按顺序执行一组动作，作为分支目标复用',
    fields: [{ key: 'actionIds', label: '动作列表', kind: 'json', required: true }],
  },
  {
    type: FLOW_END,
    title: '结束事件流',
    description: '提前终止当前链，后续动作不再执行',
    fields: [],
  },
  {
    type: 'plugin.invoke',
    title: '调用插件',
    description: '按权限声明调用插件服务',
    fields: [
      { key: 'service', label: '服务名', kind: 'text', required: true },
      { key: 'method', label: '方法名', kind: 'text', required: true },
      { key: 'args', label: '参数', kind: 'json' },
    ],
  },
]

/** 按类型取内置动作元数据；自定义类型返回 undefined */
export function findActionDefinition(type: string): ActionDefinition | undefined {
  return BUILTIN_ACTIONS.find((item) => item.type === type)
}

/**
 * 提取一个动作引用到的其他动作 id。
 *
 * 引用有三个来源：`flow.condition` 的两个分支目标、`flow.sequence` 的成员列表、
 * 以及 `onError: 'fallback'` 的补救动作。校验据此做悬空引用检查与环检测，
 * 因此**新增任何会引用动作 id 的内置类型时，必须同步改这里**，否则新类型的环
 * 只能在运行时被步数上限拦下，设计期不会报错。
 *
 * 边界行为：config 里不是字符串的值直接丢弃而不是报错——形状错误由字段校验负责，
 * 本函数只回答「引用了谁」。
 *
 * @param action 待分析的动作声明
 * @returns 被引用的动作 id，含重复项；无引用时为空数组
 */
export function referencedActionIds(action: ActionDeclaration): string[] {
  const refs: string[] = []

  if (action.onError === 'fallback' && typeof action.fallbackActionId === 'string') {
    refs.push(action.fallbackActionId)
  }

  if (action.type === FLOW_CONDITION) {
    for (const key of ['trueActionId', 'falseActionId']) {
      const value = action.config[key]
      if (typeof value === 'string' && value) refs.push(value)
    }
  }

  if (action.type === FLOW_SEQUENCE) {
    const members = action.config.actionIds
    if (Array.isArray(members)) {
      for (const member of members) {
        if (typeof member === 'string' && member) refs.push(member)
      }
    }
  }

  return refs
}
