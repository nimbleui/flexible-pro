import type {
  ActionDeclaration,
  EventConnection,
  EventDefinition,
  ValidationIssue,
} from '@lc/schema'
import { findActionDefinition, isExpressionString } from '@lc/schema'

/**
 * 节点事件绑定的纯换算。
 *
 * 连接与动作分处两张表，「这个节点绑了哪些事件」需要把两边按 id 拼起来；拼法放在
 * 这里而不是组件里，是因为它决定了面板显示什么、删绑定时连带删掉什么，必须能脱离
 * 文档服务单独验证。
 */

/** 面板事件列表的一行：一个可绑定事件与它当前的连接 */
export interface EventRow {
  /** 事件名，行的唯一标识 */
  eventName: string
  /** 物料或页面 schema 里的事件声明；手填的自定义事件为 `undefined` */
  definition?: EventDefinition
  /** 该事件当前的连接；未绑定为 `undefined` */
  connection?: EventConnection
}

/** 动作链里的一步摘要，只用于展示 */
export interface ChainStep {
  /** 动作 id */
  id: string
  /** 展示名：自定义 name 优先，其次内置类型标题，都没有时用 id */
  title: string
  /** 动作类型原文 */
  type: string
  /** 配置摘要；无字段或无值时为空串 */
  summary: string
}

/**
 * 页面 schema 里组件声明的读取面。
 *
 * 只声明本函数实际读的两个字段，而不是整个 `ComponentSchema`：蓝图、节点表与主题
 * 都与「这个组件声明了哪些事件」无关，收窄之后测试也不必造一份假蓝图出来。
 */
export interface ComponentEventSource {
  /** 组件元数据，只用 `name` 与节点的 componentName 匹配 */
  meta: { name: string }
  /** 组件声明的事件（可选） */
  events?: EventDefinition[]
}

/**
 * 合并节点可绑定的事件声明。
 *
 * 两个来源：页面 schema 的 `components[].events`（协议的强类型来源）与物料服务登记的
 * `events`。自定义组件只在其中一侧声明是常态，因此两侧都读、按事件名去重，页面 schema
 * 先写者胜出。
 */
export function collectEventDefinitions(
  components: readonly ComponentEventSource[],
  componentName: string,
  materialEvents?: readonly EventDefinition[],
): EventDefinition[] {
  const merged = new Map<string, EventDefinition>()

  for (const component of components) {
    if (component.meta.name !== componentName) continue
    for (const event of component.events ?? []) {
      if (!merged.has(event.name)) merged.set(event.name, event)
    }
  }

  for (const event of materialEvents ?? []) {
    if (!merged.has(event.name)) merged.set(event.name, event)
  }

  return [...merged.values()]
}

/** 取某节点的全部连接；顺序即文档里的键顺序，面板按它展示 */
export function connectionsOfNode(
  connections: Readonly<Record<string, EventConnection>>,
  nodeId: string,
): EventConnection[] {
  return Object.values(connections).filter((item) => item.sourceNodeId === nodeId)
}

/**
 * 生成事件行：先列声明过的事件（未绑定的也要出现，否则用户不知道有这个可绑），
 * 再补上没声明却已绑定的自定义事件（不显示就等于看不见一条正在生效的连接）。
 *
 * 事件名是行的唯一标识：同一事件的第二条连接属于配置错误（校验会报错），不能再开一行，
 * 否则面板会显示两条都能解绑、实际只有一条会执行的假象。
 */
export function buildEventRows(
  definitions: readonly EventDefinition[],
  connections: readonly EventConnection[],
): EventRow[] {
  const byEvent = new Map<string, EventConnection>()
  for (const connection of connections) {
    if (!byEvent.has(connection.eventName)) byEvent.set(connection.eventName, connection)
  }

  const rows: EventRow[] = []
  const listed = new Set<string>()

  for (const definition of definitions) {
    if (listed.has(definition.name)) continue
    listed.add(definition.name)
    rows.push({
      eventName: definition.name,
      definition,
      connection: byEvent.get(definition.name),
    })
  }

  for (const connection of connections) {
    if (listed.has(connection.eventName)) continue
    listed.add(connection.eventName)
    rows.push({ eventName: connection.eventName, connection })
  }

  return rows
}

/** 动作值的单行文本；表达式取 `raw`，对象数组压成紧凑 JSON */
function configValueText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (isExpressionString(value)) return value.raw
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/**
 * 按内置动作的字段声明生成配置摘要。
 *
 * 只读展示，不解释语义：自定义动作类型没有字段声明，摘要为空串，面板据此显示类型名。
 * 值缺失的字段跳过，全空时返回空串而不是「未配置」，让调用方决定怎么措辞。
 */
export function summarizeConfig(action: ActionDeclaration): string {
  const fields = findActionDefinition(action.type)?.fields ?? []

  const parts: string[] = []
  for (const field of fields) {
    const text = configValueText(action.config[field.key])
    if (text !== '') parts.push(`${field.label}=${text}`)
  }

  return parts.join(' · ')
}

/** 生成动作链摘要；引用到不存在的动作时保留占位步骤，让断链在面板上可见 */
export function describeChain(
  actions: Readonly<Record<string, ActionDeclaration>>,
  actionIds: readonly string[],
): ChainStep[] {
  return actionIds.map((id) => {
    const action = actions[id]
    const type = action?.type ?? '（动作已丢失）'
    const fields = findActionDefinition(type)?.fields ?? []

    let summary = action ? summarizeConfig(action) : '引用了不存在的动作'
    // 有字段声明却一个都没填：不写出来的话，面板上是一条看起来正常、实际什么都不做的动作
    if (action && summary === '' && fields.length > 0) summary = '未填写参数'

    return {
      id,
      type,
      title: action?.name ?? findActionDefinition(type)?.title ?? id,
      summary,
    }
  })
}

/**
 * 删除一条连接之后会变成孤儿的动作 id。
 *
 * 动作可在多条连接间复用，只有其它连接不再引用它时才该跟着绑定一起删；
 * 否则「解绑一个按钮」会把别的事件的动作链一起删断。
 */
export function orphanedActionIds(
  connections: Readonly<Record<string, EventConnection>>,
  removed: EventConnection,
  actions: Readonly<Record<string, ActionDeclaration>>,
): string[] {
  return removed.actionIds.filter((actionId) => {
    if (!actions[actionId]) return false
    const stillUsed = Object.values(connections).some(
      (item) => item.id !== removed.id && item.actionIds.includes(actionId),
    )
    return !stillUsed
  })
}

/**
 * 过滤出与这些连接及其动作相关的校验问题。
 *
 * `validateDocument` 用原始 id 拼路径，而本面板拿到的连接 id 也是原值，因此直接比对
 * `/connections/<id>` 与 `/actions/<id>` 两种前缀即可。
 */
export function issuesForConnections(
  issues: readonly ValidationIssue[],
  connections: readonly EventConnection[],
  actions: Readonly<Record<string, ActionDeclaration>>,
): ValidationIssue[] {
  const prefixes = new Set<string>()
  for (const connection of connections) {
    prefixes.add(`/connections/${connection.id}`)
    for (const actionId of connection.actionIds) {
      if (actions[actionId]) prefixes.add(`/actions/${actionId}`)
    }
  }

  return issues.filter((issue) =>
    [...prefixes].some(
      (prefix) => issue.path === prefix || issue.path.startsWith(`${prefix}/`),
    ),
  )
}
