/**
 * 事件与动作协议（对应《Schema 与物料协议》§2.8）
 * ---
 * 低代码平台不能把 `onClick` 函数存进 Schema：函数无法安全序列化，也不便于版本迁移、
 * 审计与可视化编辑。这里采用「事件连接 + 动作定义」两步：
 *  - `EventConnection` 只描述「哪个节点的哪个事件，按顺序执行哪些动作」；
 *  - `ActionDeclaration` 独立成集合，由 id 被连接引用，便于复用与单独迁移。
 *
 * 顺序即执行顺序（`actionIds` 的数组顺序），条件分支由动作类型 `flow.condition` 表达，
 * 因此不需要额外的图结构：一张「事件流」在数据上就是一条动作序列。
 */

import type { ExpressionString } from './expression'

/**
 * 动作声明
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
  /** 执行条件（可选）：求值为假时跳过本动作，不影响后续动作 */
  condition?: ExpressionString
  /**
   * 失败策略（可选）。
   * - `stop`：中断整条事件流（默认）
   * - `continue`：忽略本次失败继续执行后续动作
   * - `fallback`：执行 `config.fallbackActionId` 指定的补救动作
   *
   * @default 'stop'
   */
  onError?: 'stop' | 'continue' | 'fallback'
}

/**
 * 事件连接
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
  /** 事件名；节点事件取自物料的事件声明，页面级事件取自 {@link PAGE_EVENTS} */
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
  kind: 'text' | 'number' | 'select' | 'toggle' | 'json'
  /** 是否必填 */
  required?: boolean
  /** `select` 的候选项 */
  options?: ReadonlyArray<{ value: string; label: string }>
  /** 占位提示 */
  placeholder?: string
}

/** 内置动作的元数据 */
export interface ActionDefinition {
  /** 动作类型标识 */
  type: string
  /** 显示名 */
  title: string
  /** 一句话说明，用于动作选择器 */
  description: string
  /** 配置字段 */
  fields: readonly ActionFieldSchema[]
}

/**
 * 首期内置动作（协议 §2.8 建议清单）。
 *
 * 每种动作都必须有独立的参数描述；`plugin.invoke` 只按声明调用插件服务，
 * 不允许直接访问插件内部对象，因此它的配置里只有服务名与方法名。
 */
export const BUILTIN_ACTIONS: readonly ActionDefinition[] = [
  {
    type: 'state.set',
    title: '更新状态',
    description: '写入页面状态变量',
    fields: [
      { key: 'key', label: '变量名', kind: 'text', required: true, placeholder: '如 keyword' },
      { key: 'value', label: '值', kind: 'text', required: true, placeholder: '支持 {{ }} 表达式' },
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
    type: 'flow.condition',
    title: '条件分支',
    description: '按表达式结果决定后续走向',
    fields: [
      { key: 'expression', label: '条件', kind: 'text', required: true, placeholder: '{{ count > 0 }}' },
      { key: 'trueActionId', label: '成立时执行', kind: 'text' },
      { key: 'falseActionId', label: '不成立时执行', kind: 'text' },
    ],
  },
  {
    type: 'flow.sequence',
    title: '顺序执行',
    description: '按顺序执行一组动作',
    fields: [{ key: 'actionIds', label: '动作列表', kind: 'json', required: true }],
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
