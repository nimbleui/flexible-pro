/**
 * 流程图协议（事件链的图形态）
 * ---
 * 事件链在数据上从「一条有序动作数组」升级为「一张有向图」：图本身是可独立命名、
 * 独立发版的文档，页面事件按 `sourceNodeId + eventName` 匹配到图的触发节点，
 * 执行的就是这张图的 id。因此这里与 `actions.ts` 共享同一套动作词汇：
 *  - 节点直接继承 {@link ActionDeclaration}，`type` / `config` / `condition` /
 *    `onError` 的语义与链上动作完全一致，执行器不需要第二套按类型分派的逻辑；
 *  - 顺序不再由数组下标表达，而由 {@link FlowEdge} 表达，所以图里不存在
 *    `flow.sequence`（它的职责被出边取代）。
 *
 * ## 分支为什么放在边上而不是 config 里
 *
 * 链式模型用 `flow.condition` 的 `trueActionId` / `falseActionId` 指分支目标，
 * 图里改成「出边带 branch 标记」：作者画一条线就是建立一次引用，不需要在表单里
 * 挑目标动作 id，也就不会出现悬空的目标。判定结果仍由同一个 `expression` 字段给出。
 *
 * ## 一次执行里每个节点最多跑一次
 *
 * {@link FlowDefinition} 是有向**无环**图（见 `flow-graph.ts` 的环检测），执行器按
 * 「访问过即跳过」推进。这让菱形汇聚天然成为 join：两条分支汇到同一个节点时它只跑一次，
 * 不需要额外的 join 语义。代价是回边不成立，所以「循环」只能由子流程或等待节点表达。
 */

import type { ActionDeclaration, ActionFieldSchema } from './actions'
import { FLOW_CONDITION, FLOW_END, PAGE_EVENT_SOURCE, findActionDefinition } from './actions'

/** 流程发布状态；`draft` 不参与事件匹配，只有已发布版本会被运行时执行 */
export type FlowStatus = 'draft' | 'published'

/** 节点库分组，与编排面板左侧的分类一一对应 */
export type FlowNodeCategory = 'trigger' | 'control' | 'logic' | 'data' | 'system'

/** 节点在画布世界坐标里的左上角位置；尺寸由节点类型推导，不入文档 */
export interface FlowNodePosition {
  /** 世界坐标 X */
  x: number
  /** 世界坐标 Y */
  y: number
}

/**
 * 流程图节点。
 *
 * 继承动作声明意味着「节点就是一条会被执行的动作」：执行器按 `type` 找处理器、
 * 按 `condition` 决定是否跳过、按 `onError` 处置失败，三条规则与事件链一致。
 */
export interface FlowNode extends ActionDeclaration {
  /** 节点标题缺省时取节点库里的同名条目说明 */
  name?: string
  /** 节点副标题，画布卡片第二行与右栏头部都读它 */
  description?: string
  /** 画布世界坐标；拖动节点只改这里 */
  position: FlowNodePosition
  /**
   * 入参映射（可选）：键为下游期望的参数名，值为支持 `{{ }}` 的模板。
   *
   * 与 `config` 分开的理由是执行时机：`config` 是「这个动作怎么配」，映射是
   * 「上游数据怎么灌进来」，后者需要在上游节点产出后求值，不能按静态配置处理。
   */
  inputMapping?: Record<string, unknown>
  /** 出参映射（可选）：键为本节点对外暴露的字段名，值取自动作结果 */
  outputMapping?: Record<string, unknown>
}

/** 分支路由结果：条件节点的两条边用这两个常量标记，与右栏「是 / 否」文案对应 */
export const FLOW_BRANCH_TRUE = 'true'
export const FLOW_BRANCH_FALSE = 'false'

/**
 * 连线。
 *
 * 只描述拓扑与展示，不携带条件：一条边上的守卫会让「这条分支走不走」同时取决于
 * 源节点的判定结果和边自己的表达式，调试时无法一眼看出实际路径。需要更细的分流
 * 就多画一个条件节点。
 */
export interface FlowEdge {
  /** 连线唯一标识，同时作为 `FlowDefinition.edges` 的键 */
  id: string
  /** 源节点 id */
  source: string
  /** 目标节点 id */
  target: string
  /**
   * 分支标记（可选）。
   *
   * 条件节点取 {@link FLOW_BRANCH_TRUE} / {@link FLOW_BRANCH_FALSE}，多分支节点取
   * 匹配值字符串；普通节点的连线留空表示无条件后继。
   */
  branch?: string
  /** 画布上显示的标签，缺省时条件边按 `branch` 显示「是 / 否」 */
  label?: string
}

/** 触发来源类型；决定触发节点需要填哪些字段 */
export type FlowTriggerKind =
  'pageEvent' | 'componentEvent' | 'schedule' | 'webhook' | 'systemEvent' | 'custom'

/**
 * 触发节点的配置形态。
 *
 * `sourceNodeId` / `eventName` 与 {@link EventConnection} 同名同义：事件匹配是
 * 「来源节点 + 事件名」这一个二元键，图侧不再发明第二套键名，否则运行时得同时
 * 维护两张查找表。页面级事件沿用 {@link PAGE_EVENT_SOURCE} 哨兵值。
 */
export interface FlowTriggerConfig {
  /** 触发来源类型 */
  kind: FlowTriggerKind
  /** 事件来源节点 id；页面级事件为 `'page'`，定时与 Webhook 同样用哨兵占位 */
  sourceNodeId: string
  /** 事件名；定时任务与 Webhook 用它表达任务标识与回调路径 */
  eventName: string
}

/** 流程级设置；只放执行器真正读取的项，展示类配置留在编辑器本地状态 */
export interface FlowSettings {
  /**
   * 单次执行超时（秒）；超时后未完成的分支按中止处理。
   *
   * @default 60
   */
  timeoutSeconds: number
  /**
   * 并行扇出同时最多跑几条分支。
   *
   * @default 4
   */
  maxConcurrency: number
}

/**
 * 一张流程图，即可被事件绑定的执行单元。
 *
 * 节点与连线都用 id 索引的对象而不是数组：画布上的增删改都是按 id 的定点写入，
 * 用数组会让「移动一个节点」变成整表替换，撤销栈与后续可能的协同都会被放大。
 * 执行顺序不来自键序，来自边，因此对象无序性不影响语义。
 */
export interface FlowDefinition {
  /** 流程唯一标识；事件绑定引用的就是它，改名不影响 */
  id: string
  /** 流程名，列表页与工具栏标题 */
  name: string
  /** 流程说明 */
  description?: string
  /** 发布状态 */
  status: FlowStatus
  /** 已发布版本号；从未发布过时为初始版本占位 */
  version: string
  /** 最后修改时间（ISO 字符串） */
  updatedAt: string
  /** 节点表，键为节点 id */
  nodes: Record<string, FlowNode>
  /** 连线表，键为连线 id */
  edges: Record<string, FlowEdge>
  /** 流程级设置 */
  settings: FlowSettings
}

/** 从未发布过的流程使用的版本号；首次发布即从这里开始 */
export const FLOW_INITIAL_VERSION = '1.0.0'

/** 流程级设置的缺省值 */
export const DEFAULT_FLOW_SETTINGS: FlowSettings = {
  timeoutSeconds: 60,
  maxConcurrency: 4,
}

/**
 * 图专属的节点类型。
 *
 * 只列 `actions.ts` 里没有的类型：条件、结束、状态、数据源、提示、跳转、插件调用
 * 这些既有动作类型在图里沿用原标识，避免同一件事出现两个名字。
 */
export const FLOW_TRIGGER = 'flow.trigger'
export const FLOW_SWITCH = 'flow.switch'
export const FLOW_PARALLEL = 'flow.parallel'
export const FLOW_LOOP = 'flow.loop'
export const FLOW_WAIT = 'flow.wait'
export const FLOW_DELAY = 'flow.delay'
export const FLOW_SUBFLOW = 'flow.subflow'
export const FLOW_EXPRESSION = 'flow.expression'
export const FLOW_FILTER = 'flow.filter'
export const FLOW_TRANSFORM = 'flow.transform'
export const FLOW_MERGE = 'flow.merge'
export const FLOW_SPLIT = 'flow.split'
export const FLOW_SCRIPT = 'flow.script'
export const STATE_GET = 'state.get'
export const DATA_MAPPING = 'data.mapping'
export const DATA_VALIDATE = 'data.validate'
export const DATA_FORMAT = 'data.format'
export const DATA_CACHE = 'data.cache'
export const LOG_RECORD = 'log.record'
export const ERROR_HANDLE = 'error.handle'
export const RETRY_POLICY = 'retry.policy'
export const PRECONDITION = 'precondition.check'
export const APPROVAL_SUBMIT = 'approval.submit'
export const HTTP_REQUEST = 'http.request'

/** 节点库条目：编排面板的一个可拖入项 */
export interface FlowNodeCatalogEntry {
  /** 节点库条目的稳定标识，同时作为新建节点的 `type`（触发类除外，见 `triggerKind`） */
  key: string
  /** 落图后的节点 `type`；触发类六个条目共用 {@link FLOW_TRIGGER}，靠 `triggerKind` 区分 */
  type: string
  /** 卡片与右栏头部显示的标题 */
  title: string
  /** 一句话说明，画布卡片第二行与悬浮提示都读它 */
  description: string
  /** 所属分组 */
  category: FlowNodeCategory
  /**
   * 触发来源类型。
   *
   * 仅触发类条目有值：六种触发共用一个节点类型，因为「谁触发」是同一个字段的六种取值，
   * 拆成六个类型会让执行器与校验各写六份分支，而它们的行为差别只在配置形状。
   */
  triggerKind?: FlowTriggerKind
  /**
   * 该条目落图时预置的 `config`；缺省为空对象。
   *
   * 只用于触发类写入 `kind`，其余类型的初值由 {@link createFlowNode} 按字段声明生成。
   */
  presetConfig?: Record<string, unknown>
}

/** 触发类条目的公共字段：来源与事件名决定运行时能不能匹配上 */
const TRIGGER_FIELDS: readonly ActionFieldSchema[] = [
  {
    key: 'sourceNodeId',
    label: '来源节点',
    kind: 'text',
    required: true,
    placeholder: '页面级事件填 page',
  },
  { key: 'eventName', label: '事件名', kind: 'text', required: true, placeholder: '如 click' },
]

/** 节点库全量目录；分组顺序即左侧面板的展示顺序 */
export const FLOW_NODE_CATALOG: readonly FlowNodeCatalogEntry[] = [
  {
    key: 'trigger.page',
    type: FLOW_TRIGGER,
    title: '页面事件',
    description: '页面自身事件触发',
    category: 'trigger',
    triggerKind: 'pageEvent',
    presetConfig: { sourceNodeId: PAGE_EVENT_SOURCE },
  },
  {
    key: 'trigger.component',
    type: FLOW_TRIGGER,
    title: '组件事件',
    description: '组件对外事件触发',
    category: 'trigger',
    triggerKind: 'componentEvent',
  },
  {
    key: 'trigger.schedule',
    type: FLOW_TRIGGER,
    title: '定时任务',
    description: '按 CRON 表达式触发',
    category: 'trigger',
    triggerKind: 'schedule',
  },
  {
    key: 'trigger.webhook',
    type: FLOW_TRIGGER,
    title: 'Webhook',
    description: '外部 HTTP 回调触发',
    category: 'trigger',
    triggerKind: 'webhook',
  },
  {
    key: 'trigger.system',
    type: FLOW_TRIGGER,
    title: '系统事件',
    description: '平台系统事件触发',
    category: 'trigger',
    triggerKind: 'systemEvent',
  },
  {
    key: 'trigger.custom',
    type: FLOW_TRIGGER,
    title: '自定义事件',
    description: '业务自定义事件触发',
    category: 'trigger',
    triggerKind: 'custom',
  },
  {
    key: 'control.condition',
    type: FLOW_CONDITION,
    title: '条件判断',
    description: '按表达式选择是 / 否分支',
    category: 'control',
  },
  {
    key: 'control.switch',
    type: FLOW_SWITCH,
    title: '多分支',
    description: '按表达式值匹配多条出边',
    category: 'control',
  },
  {
    key: 'control.loop',
    type: FLOW_LOOP,
    title: '循环',
    description: '对集合逐项重复执行子图',
    category: 'control',
  },
  {
    key: 'control.parallel',
    type: FLOW_PARALLEL,
    title: '并行执行',
    description: '多条出边同时执行',
    category: 'control',
  },
  {
    key: 'control.wait',
    type: FLOW_WAIT,
    title: '等待',
    description: '等待外部信号或条件成立',
    category: 'control',
  },
  {
    key: 'control.delay',
    type: FLOW_DELAY,
    title: '延迟',
    description: '按毫秒暂停后续节点',
    category: 'control',
  },
  {
    key: 'control.end',
    type: FLOW_END,
    title: '结束',
    description: '提前终止本次流程',
    category: 'control',
  },
  {
    key: 'control.subflow',
    type: FLOW_SUBFLOW,
    title: '子流程',
    description: '调用另一张已发布流程图',
    category: 'control',
  },
  {
    key: 'logic.expression',
    type: FLOW_EXPRESSION,
    title: '表达式计算',
    description: '求值并写入结果变量',
    category: 'logic',
  },
  {
    key: 'logic.filter',
    type: FLOW_FILTER,
    title: '数据过滤',
    description: '按条件筛掉集合元素',
    category: 'logic',
  },
  {
    key: 'logic.transform',
    type: FLOW_TRANSFORM,
    title: '数据转换',
    description: '按映射改写数据结构',
    category: 'logic',
  },
  {
    key: 'logic.merge',
    type: FLOW_MERGE,
    title: '数据合并',
    description: '合并多个来源的结果',
    category: 'logic',
  },
  {
    key: 'logic.split',
    type: FLOW_SPLIT,
    title: '数据拆分',
    description: '把一个集合拆成多份',
    category: 'logic',
  },
  {
    key: 'logic.script',
    type: FLOW_SCRIPT,
    title: '脚本执行',
    description: '在沙箱里执行一段脚本',
    category: 'logic',
  },
  {
    key: 'data.get',
    type: STATE_GET,
    title: '读取变量',
    description: '读取流程上下文变量',
    category: 'data',
  },
  {
    key: 'data.set',
    type: 'state.set',
    title: '设置变量',
    description: '写入流程上下文变量',
    category: 'data',
  },
  {
    key: 'data.mapping',
    type: DATA_MAPPING,
    title: '数据映射',
    description: '按字段映射改写输出',
    category: 'data',
  },
  {
    key: 'data.validate',
    type: DATA_VALIDATE,
    title: '数据校验',
    description: '按规则校验字段',
    category: 'data',
  },
  {
    key: 'data.format',
    type: DATA_FORMAT,
    title: '数据格式化',
    description: '按模板格式化输出',
    category: 'data',
  },
  {
    key: 'data.cache',
    type: DATA_CACHE,
    title: '缓存数据',
    description: '写入可复用的中间结果',
    category: 'data',
  },
  {
    key: 'system.log',
    type: LOG_RECORD,
    title: '日志记录',
    description: '输出一条执行日志',
    category: 'system',
  },
  {
    key: 'system.error',
    type: ERROR_HANDLE,
    title: '异常处理',
    description: '捕获上游异常并给出处置',
    category: 'system',
  },
  {
    key: 'system.retry',
    type: RETRY_POLICY,
    title: '重试策略',
    description: '按次数与间隔重试后续节点',
    category: 'system',
  },
  {
    key: 'system.precondition',
    type: PRECONDITION,
    title: '前置校验',
    description: '不满足则跳过后续节点',
    category: 'system',
  },
  {
    key: 'system.approval',
    type: APPROVAL_SUBMIT,
    title: '提交审批',
    description: '调用审批流程发起审批',
    category: 'system',
  },
  {
    key: 'system.http',
    type: HTTP_REQUEST,
    title: '调用接口',
    description: '发起一次 HTTP 请求',
    category: 'system',
  },
  {
    key: 'system.toast',
    type: 'ui.toast',
    title: '发送通知',
    description: '向用户弹出一条提示',
    category: 'system',
  },
]

/**
 * 图专属节点的配置字段。
 *
 * 与 `BUILTIN_ACTIONS` 一样只描述「渲染表单需要什么」：协议层不认识 DOM 和请求，
 * 执行能力由运行时注册的处理器提供。未在此列出的类型（含所有既有动作类型）
 * 由 {@link flowNodeFields} 回落到内置动作声明。
 */
const FLOW_NODE_FIELDS: Readonly<Record<string, readonly ActionFieldSchema[]>> = {
  [FLOW_TRIGGER]: TRIGGER_FIELDS,
  // 图里的分支由出边的 branch 标记表达，链式模型那两个「目标动作 id」字段必须屏蔽掉：
  // 留着它们，右栏会渲染两个「分支目标」下拉，而它们在执行器里根本不被读取。
  [FLOW_CONDITION]: [
    {
      key: 'expression',
      label: '条件',
      kind: 'expression',
      required: true,
      placeholder: '{{ data.amount > 1000 }}',
    },
  ],
  [FLOW_END]: [],
  [FLOW_SWITCH]: [
    {
      key: 'expression',
      label: '匹配表达式',
      kind: 'expression',
      required: true,
      placeholder: '{{ status }}',
    },
  ],
  [FLOW_DELAY]: [
    {
      key: 'milliseconds',
      label: '延迟毫秒',
      kind: 'number',
      required: true,
      placeholder: '1000',
    },
  ],
  [FLOW_SUBFLOW]: [
    {
      key: 'flowId',
      label: '目标流程',
      kind: 'text',
      required: true,
      placeholder: '已发布流程的 id',
    },
  ],
  [FLOW_EXPRESSION]: [
    {
      key: 'expression',
      label: '表达式',
      kind: 'expression',
      required: true,
      placeholder: '{{ amount * 0.1 }}',
    },
    { key: 'assignTo', label: '结果变量', kind: 'text', required: true, placeholder: '如 tax' },
  ],
  [FLOW_FILTER]: [
    {
      key: 'source',
      label: '集合表达式',
      kind: 'expression',
      required: true,
      placeholder: '{{ list }}',
    },
    {
      key: 'predicate',
      label: '保留条件',
      kind: 'expression',
      required: true,
      placeholder: '{{ item.amount > 0 }}',
    },
    { key: 'assignTo', label: '结果变量', kind: 'text', required: true },
  ],
  [FLOW_TRANSFORM]: [
    { key: 'source', label: '输入表达式', kind: 'expression', required: true },
    { key: 'mapping', label: '字段映射', kind: 'json', required: true },
    { key: 'assignTo', label: '结果变量', kind: 'text', required: true },
  ],
  [FLOW_MERGE]: [
    { key: 'sources', label: '待合并变量', kind: 'json', required: true },
    { key: 'assignTo', label: '结果变量', kind: 'text', required: true },
  ],
  [FLOW_SPLIT]: [
    { key: 'source', label: '集合表达式', kind: 'expression', required: true },
    { key: 'chunkSize', label: '每份条数', kind: 'number', required: true },
    { key: 'assignTo', label: '结果变量', kind: 'text', required: true },
  ],
  [FLOW_SCRIPT]: [{ key: 'script', label: '脚本', kind: 'json', required: true }],
  [FLOW_LOOP]: [
    { key: 'source', label: '集合表达式', kind: 'expression', required: true },
    { key: 'itemVariable', label: '元素变量', kind: 'text', placeholder: '如 item' },
  ],
  [FLOW_WAIT]: [
    {
      key: 'signal',
      label: '等待信号',
      kind: 'text',
      required: true,
      placeholder: '外部信号标识',
    },
    { key: 'timeoutSeconds', label: '超时（秒）', kind: 'number' },
  ],
  [STATE_GET]: [
    { key: 'key', label: '变量名', kind: 'text', required: true, placeholder: '如 orderId' },
    { key: 'assignTo', label: '结果变量', kind: 'text', placeholder: '缺省写回同名变量' },
  ],
  [DATA_MAPPING]: [
    { key: 'source', label: '输入表达式', kind: 'expression', required: true },
    { key: 'mapping', label: '字段映射', kind: 'json', required: true },
    { key: 'assignTo', label: '结果变量', kind: 'text', required: true },
  ],
  [DATA_VALIDATE]: [
    { key: 'source', label: '待校验数据', kind: 'expression', required: true },
    { key: 'rules', label: '校验规则', kind: 'json', required: true },
  ],
  [DATA_FORMAT]: [
    { key: 'source', label: '输入表达式', kind: 'expression', required: true },
    {
      key: 'template',
      label: '输出模板',
      kind: 'text',
      required: true,
      placeholder: '{{ amount }} 元',
    },
    { key: 'assignTo', label: '结果变量', kind: 'text', required: true },
  ],
  [DATA_CACHE]: [
    { key: 'key', label: '缓存键', kind: 'text', required: true },
    { key: 'source', label: '缓存内容', kind: 'expression', required: true },
  ],
  [LOG_RECORD]: [
    {
      key: 'message',
      label: '日志内容',
      kind: 'text',
      required: true,
      placeholder: '支持 {{ }} 表达式',
    },
    {
      key: 'level',
      label: '级别',
      kind: 'select',
      options: [
        { value: 'debug', label: '调试' },
        { value: 'info', label: '信息' },
        { value: 'warning', label: '警告' },
        { value: 'error', label: '错误' },
      ],
    },
  ],
  [ERROR_HANDLE]: [
    {
      key: 'strategy',
      label: '处置方式',
      kind: 'select',
      required: true,
      options: [
        { value: 'stop', label: '中断流程' },
        { value: 'continue', label: '忽略并继续' },
        { value: 'fallback', label: '转补救节点' },
      ],
    },
  ],
  [RETRY_POLICY]: [
    { key: 'attempts', label: '重试次数', kind: 'number', required: true },
    { key: 'intervalMs', label: '重试间隔（毫秒）', kind: 'number' },
  ],
  [PRECONDITION]: [
    {
      key: 'expression',
      label: '前置条件',
      kind: 'expression',
      required: true,
      placeholder: '{{ user.role === "admin" }}',
    },
  ],
  [APPROVAL_SUBMIT]: [
    { key: 'template', label: '审批模板', kind: 'text', required: true },
    { key: 'assignee', label: '审批人', kind: 'text', required: true },
    {
      key: 'mode',
      label: '处理方式',
      kind: 'select',
      options: [
        { value: 'any', label: '或签' },
        { value: 'all', label: '会签' },
      ],
    },
    { key: 'timeoutHours', label: '超时时间（小时）', kind: 'number' },
  ],
  [HTTP_REQUEST]: [
    {
      key: 'method',
      label: '方法',
      kind: 'select',
      required: true,
      options: [
        { value: 'GET', label: 'GET' },
        { value: 'POST', label: 'POST' },
        { value: 'PUT', label: 'PUT' },
        { value: 'DELETE', label: 'DELETE' },
      ],
    },
    { key: 'url', label: '地址', kind: 'text', required: true },
    { key: 'body', label: '请求体', kind: 'json' },
    { key: 'assignTo', label: '结果变量', kind: 'text' },
  ],
  [FLOW_PARALLEL]: [],
}

/** 分组标题，供面板按 {@link FlowNodeCategory} 渲染折叠区 */
export const FLOW_NODE_CATEGORY_LABELS: Readonly<Record<FlowNodeCategory, string>> = {
  trigger: '触发节点',
  control: '流程控制',
  logic: '逻辑处理',
  data: '数据处理',
  system: '系统工具',
}

/** 按 `type` 索引的目录条目；触发类六个条目共用一个 type，因此该索引只回落到首个匹配 */
const CATALOG_BY_TYPE = new Map(FLOW_NODE_CATALOG.map((entry) => [entry.type, entry]))

/** 按 `key` 索引的目录条目；面板与新建节点走这个，触发类不会互相覆盖 */
const CATALOG_BY_KEY = new Map(FLOW_NODE_CATALOG.map((entry) => [entry.key, entry]))

/**
 * 取节点库条目。
 *
 * 面板与画布按 `key` 拿到条目后才能知道它落图时的 `type`：触发类六个条目共用一个
 * `type`，只有 key 能区分它们。
 *
 * @param key 节点库条目 key
 * @returns 条目；未知 key 返回 undefined
 */
export function findFlowCatalogEntry(key: string): FlowNodeCatalogEntry | undefined {
  return CATALOG_BY_KEY.get(key)
}

/** 取某个节点类型在画布与右栏的展示元数据；未在册类型返回 undefined */
export function findFlowNodeType(type: string): FlowNodeCatalogEntry | undefined {
  return CATALOG_BY_TYPE.get(type)
}

/**
 * 取节点类型的配置字段声明。
 *
 * 优先图专属声明，其次回落到内置动作清单：`state.set`、`ui.toast`、`flow.condition`
 * 这些类型在链与图里是同一件事，表单字段不该声明两遍。两处都没有说明是插件自定义
 * 类型，返回空数组表示「本层不知道它需要什么配置」。
 *
 * @param type 节点 `type`
 * @returns 字段声明列表，按表单展示顺序
 */
export function flowNodeFields(type: string): readonly ActionFieldSchema[] {
  const declared = FLOW_NODE_FIELDS[type]
  if (declared) return declared

  return findActionDefinition(type)?.fields ?? []
}

/**
 * 按节点库条目生成一个节点。
 *
 * 必填字段预置空串而不是省略：右栏表单要能立刻渲染出输入框，缺字段时面板得自己
 * 判断「是没填还是没这个字段」，那条规则会在每个控件里重复一遍。`json` 字段例外——
 * 它的空值形态是「没有这个键」，预置成空串会让解析器报一条用户没写过的语法错误。
 *
 * @param key 节点库条目 key
 * @param id 调用方分配的稳定 id
 * @param position 落点世界坐标
 * @returns 可直接写入 `FlowDefinition.nodes` 的节点
 * @throws key 不在节点库中时抛错，避免面板拼错 key 后静默生成空节点
 */
export function createFlowNode(key: string, id: string, position: FlowNodePosition): FlowNode {
  const entry = CATALOG_BY_KEY.get(key)
  if (!entry) throw new Error(`[schema] 节点库中不存在条目: ${key}`)

  const config: Record<string, unknown> = { ...entry.presetConfig }

  if (entry.triggerKind) config.kind = entry.triggerKind

  for (const field of flowNodeFields(entry.type)) {
    if (field.kind === 'json' || config[field.key] !== undefined) continue
    config[field.key] = ''
  }

  return {
    id,
    type: entry.type,
    name: entry.title,
    description: entry.description,
    position: { ...position },
    config,
  }
}

/** 触发类节点的 `type`；面板与校验都按它判断分组归属 */
export function isFlowTriggerNode(node: FlowNode): boolean {
  return node.type === FLOW_TRIGGER
}

/** 节点判定后需要按 {@link FlowEdge.branch} 挑一条出边；右栏连线配置据此开放「分支」字段 */
export const FLOW_BRANCH_TYPES: ReadonlySet<string> = new Set([FLOW_CONDITION, FLOW_SWITCH])

/**
 * 节点是否按判定结果选边。
 *
 * @param node 待判定的节点
 * @returns 是条件类节点时返回 true
 */
export function isFlowBranchNode(node: FlowNode): boolean {
  return FLOW_BRANCH_TYPES.has(node.type)
}

/**
 * 读取触发节点的绑定。
 *
 * `kind` 只影响面板展示，执行侧真正用于匹配的仍是「来源节点 + 事件名」二元键；
 * 字段缺失或类型不对时返回 null，由调用方决定是提示还是忽略——运行时匹配到 null
 * 的流程不参与事件分派，这比拿一个 `undefined` 去比较更安全。
 *
 * @param node 待判定的节点
 * @returns 绑定信息；非触发节点或配置不完整时为 null
 */
export function readFlowTriggerBinding(node: FlowNode): FlowTriggerConfig | null {
  if (!isFlowTriggerNode(node)) return null

  const { kind, sourceNodeId, eventName } = node.config as Partial<FlowTriggerConfig>
  if (typeof sourceNodeId !== 'string' || sourceNodeId === '') return null
  if (typeof eventName !== 'string' || eventName === '') return null

  return {
    kind: typeof kind === 'string' ? (kind as FlowTriggerKind) : 'custom',
    sourceNodeId,
    eventName,
  }
}

/**
 * 取一张图的触发绑定。
 *
 * 一张图只允许一个触发节点（见 `flow-graph.ts` 的校验），因此这里取第一个触发节点
 * 即可；没有触发节点的图不可执行，返回 undefined 由发布校验拦下。
 */
export function flowBindingOf(flow: FlowDefinition): FlowTriggerConfig | undefined {
  for (const node of Object.values(flow.nodes)) {
    const binding = readFlowTriggerBinding(node)
    if (binding) return binding
  }

  return undefined
}

/** 事件匹配键；同一时刻只能有一条已发布流程占用，避免一个事件触发多张图 */
export function flowEventKey(sourceNodeId: string, eventName: string): string {
  return `${sourceNodeId}:${eventName}`
}
