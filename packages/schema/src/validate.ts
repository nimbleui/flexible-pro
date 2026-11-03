/**
 * Schema 校验
 * ---
 * 只做「结构一致性」检查：引用完整性、必要字段、明显的非法配置。
 * 组件语义校验（属性类型、事件动作是否存在）由 material / action 服务负责，
 * 不属于纯 schema 包。
 */

import { PAGE_EVENT_SOURCE, findActionDefinition, referencedActionIds } from './actions'
import type { ActionDeclaration, ActionFieldSchema, EventConnection } from './actions'
import { isExpressionString } from './expression'
import type { NodeSchema } from './node'
import type { PageSchema } from './page'

/** 校验问题级别 */
export type ValidationSeverity = 'error' | 'warning'

/** 单条校验问题 */
export interface ValidationIssue {
  /** 出问题的位置（节点 id 路径或 schema 字段路径） */
  path: string
  /** 可读描述 */
  message: string
  /** 级别；error 阻断保存/发布，warning 仅提示 */
  severity: ValidationSeverity
}

/**
 * 表达式形态字段的形状检查。
 *
 * `kind: 'expression'` 的字段在执行器里走「解析后取真值」的路径：值若是裸文本
 * `'count > 0'`，解析结果是一个非空字符串、恒为真，分支会永远走成立一侧且不报任何错。
 * 所以这类字段必须是真正的表达式对象。
 *
 * 字段声明由调用方给出而不是在这里按 type 查表：同一份检查同时服务于页面动作
 * （声明在 `BUILTIN_ACTIONS`）和流程图节点（声明在 `FLOW_NODE_FIELDS`），
 * 查表规则各自不同，但「表达式不能是裸文本」这条约束是同一个。
 *
 * @param action 待检查的动作或流程节点（节点继承动作声明，形状一致）
 * @param fields 该类型的字段声明
 * @param basePath 问题路径前缀，如 `/actions/a1`；产出的路径为 `<basePath>/config/<key>`
 * @returns 表达式字段的缺失与形状问题
 */
export function checkExpressionFields(
  action: ActionDeclaration,
  fields: readonly ActionFieldSchema[],
  basePath: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const field of fields) {
    if (field.kind !== 'expression') continue

    const value = action.config[field.key]
    if (value === undefined) {
      if (field.required) {
        issues.push({
          path: `${basePath}/config/${field.key}`,
          message: `${field.label}未填写`,
          severity: 'error',
        })
      }
      continue
    }

    if (!isExpressionString(value)) {
      issues.push({
        path: `${basePath}/config/${field.key}`,
        message: `${field.label}必须是 {{ }} 表达式；裸文本会被当作常量而恒为真`,
        severity: 'error',
      })
    }
  }

  return issues
}

/**
 * 动作表自身的一致性。
 *
 * 检查四件事：键与 id 一致、type 非空、`onError: 'fallback'` 必须带补救动作、
 * 动作引用的其他动作必须存在。引用环单独由 {@link detectActionCycles} 处理，
 * 因为环是整张引用图的性质，逐条动作看不出来。
 */
function validateActions(
  actions: Readonly<Record<string, ActionDeclaration>>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const [key, action] of Object.entries(actions)) {
    if (action.id !== key) {
      issues.push({
        path: `/actions/${key}/id`,
        message: `动作键 "${key}" 与动作 id "${action.id}" 不一致`,
        severity: 'error',
      })
    }

    if (!action.type) {
      issues.push({
        path: `/actions/${key}/type`,
        message: '动作缺少 type，无法选择执行器',
        severity: 'error',
      })
    }

    if (action.onError === 'fallback' && !action.fallbackActionId) {
      issues.push({
        path: `/actions/${key}/fallbackActionId`,
        message: '失败策略为 fallback，但未指定补救动作',
        severity: 'error',
      })
    }

    for (const ref of referencedActionIds(action)) {
      if (!actions[ref]) {
        issues.push({
          path: `/actions/${key}`,
          message: `引用的动作 "${ref}" 不存在`,
          severity: 'error',
        })
      }
    }

    issues.push(
      ...checkExpressionFields(
        action,
        findActionDefinition(action.type)?.fields ?? [],
        `/actions/${action.id}`,
      ),
    )
  }

  return issues
}

/**
 * 检测动作引用图里的环。
 *
 * `flow.condition` 的分支目标、`flow.sequence` 的成员和 `fallback` 补救动作都能指向
 * 另一个动作，因此引用图可以成环；环一旦成立，执行器只能靠步数上限硬停，用户看到的
 * 是「点了没反应」而不是「这里配错了」。设计期必须拦住。
 *
 * 用三色 DFS：栈上节点被再次访问即为环。同一个环从不同入口会被走到多次，
 * 按环上节点集合去重，只报一次。
 *
 * 递归深度等于动作引用链长度，页面级动作表规模为数十条，不需要改成显式栈。
 */
function detectActionCycles(
  actions: Readonly<Record<string, ActionDeclaration>>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const finished = new Set<string>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const reported = new Set<string>()

  const visit = (id: string): void => {
    if (finished.has(id)) return

    if (onStack.has(id)) {
      const cycle = stack.slice(stack.indexOf(id))
      const key = [...cycle].sort().join('\u0000')
      if (reported.has(key)) return

      reported.add(key)
      issues.push({
        path: `/actions/${id}`,
        message: `动作引用形成环：${[...cycle, id].join(' → ')}`,
        severity: 'error',
      })
      return
    }

    const action = actions[id]
    // 悬空引用已由 validateActions 报错，这里直接跳过，避免同一个问题报两次
    if (!action) return

    onStack.add(id)
    stack.push(id)

    for (const next of referencedActionIds(action)) visit(next)

    stack.pop()
    onStack.delete(id)
    finished.add(id)
  }

  for (const id of Object.keys(actions)) visit(id)

  return issues
}

/**
 * 把「被连接直接引用」的动作集合扩展为传递闭包。
 *
 * 只被某个 `flow.sequence` 成员引用、而自身没出现在任何连接里的动作是活配置，
 * 不该被报成孤儿。用工作列表而不是递归，闭包规模与动作数同阶。
 */
function expandUsedActions(
  actions: Readonly<Record<string, ActionDeclaration>>,
  used: Set<string>,
): void {
  const pending = [...used]

  while (pending.length > 0) {
    const id = pending.pop() as string
    const action = actions[id]
    if (!action) continue

    for (const ref of referencedActionIds(action)) {
      if (used.has(ref)) continue

      used.add(ref)
      pending.push(ref)
    }
  }
}

/**
 * 连接表的一致性检查。
 *
 * 除产出问题外还返回被引用的动作 id 集合：「未被使用的动作」只能在这之后判定，
 * 传参返回而不是让调用方再扫一遍连接。
 */
function validateConnections(
  connections: Readonly<Record<string, EventConnection>>,
  nodes: Readonly<Record<string, NodeSchema>>,
  actions: Readonly<Record<string, ActionDeclaration>>,
): {
  /** 连接表逐条产出的问题；顺序与 Object.entries(connections) 一致，面板据此展示 */
  issues: ValidationIssue[]
  /** 被至少一条连接引用的动作 id；供上层反推孤儿动作，不让调用方再扫一遍连接 */
  usedActions: Set<string>
} {
  const issues: ValidationIssue[] = []
  const usedActions = new Set<string>()
  // 同一节点的同一事件绑定多条连接，执行顺序无定义；值为首个占用该事件键的连接 id
  const connectionSources = new Map<string, string>()

  for (const [key, connection] of Object.entries(connections)) {
    checkConnection(key, connection, nodes, actions, issues, usedActions, connectionSources)
  }

  return { issues, usedActions }
}

/**
 * 单条连接的一致性检查：键/id、事件来源、引用动作、事件重复绑定。
 *
 * 问题与引用集合都通过出参累加——usedActions / connectionSources 是跨连接共享的
 * 单遍游标，改成返回值反而要在外层再合并一次。四条检查的先后即产出顺序，勿调换。
 */
function checkConnection(
  key: string,
  connection: EventConnection,
  nodes: Readonly<Record<string, NodeSchema>>,
  actions: Readonly<Record<string, ActionDeclaration>>,
  issues: ValidationIssue[],
  usedActions: Set<string>,
  connectionSources: Map<string, string>,
): void {
  if (connection.id !== key) {
    issues.push({
      path: `/connections/${key}/id`,
      message: `连接键 "${key}" 与连接 id "${connection.id}" 不一致`,
      severity: 'error',
    })
  }

  if (connection.sourceNodeId !== PAGE_EVENT_SOURCE && !nodes[connection.sourceNodeId]) {
    issues.push({
      path: `/connections/${key}/sourceNodeId`,
      message: `事件来源节点 "${connection.sourceNodeId}" 不存在`,
      severity: 'error',
    })
  }

  collectConnectionActions(key, connection.actionIds, actions, issues, usedActions)
  registerConnectionEvent(key, connection, connectionSources, issues)
}

/** 连接引用的动作：不存在的报错，存在的计入 usedActions（孤儿判定据此反推） */
function collectConnectionActions(
  key: string,
  actionIds: readonly string[],
  actions: Readonly<Record<string, ActionDeclaration>>,
  issues: ValidationIssue[],
  usedActions: Set<string>,
): void {
  for (const actionId of actionIds) {
    if (!actions[actionId]) {
      issues.push({
        path: `/connections/${key}/actionIds`,
        message: `连接引用的动作 "${actionId}" 不存在`,
        severity: 'error',
      })
    } else {
      usedActions.add(actionId)
    }
  }
}

/**
 * 登记 `sourceNodeId:eventName` 事件键；被第二条连接重复绑定时报与首条的冲突。
 * 首条占用者写入 connectionSources，供后续连接比对。
 */
function registerConnectionEvent(
  key: string,
  connection: EventConnection,
  connectionSources: Map<string, string>,
  issues: ValidationIssue[],
): void {
  const sourceKey = `${connection.sourceNodeId}:${connection.eventName}`
  const duplicated = connectionSources.get(sourceKey)
  if (duplicated) {
    issues.push({
      path: `/connections/${key}`,
      message: `与连接 "${duplicated}" 绑定了同一个事件 "${sourceKey}"`,
      severity: 'error',
    })
  } else {
    connectionSources.set(sourceKey, key)
  }
}

/** 未被任何连接引用的动作属于死配置，只提示不阻断 */
function validateUnusedActions(
  actions: Readonly<Record<string, ActionDeclaration>>,
  usedActions: ReadonlySet<string>,
): ValidationIssue[] {
  return Object.keys(actions)
    .filter((actionId) => !usedActions.has(actionId))
    .map((actionId) => ({
      path: `/actions/${actionId}`,
      message: '动作未被任何事件连接引用',
      severity: 'warning' as const,
    }))
}

/**
 * 单个节点的结构一致性：键与 id 一致、componentName 非空、子引用指向存在的节点。
 *
 * 子节点缺失一律 error：引用断链在渲染时会被静默跳过，画布上「节点凭空少一层」
 * 比报错更难排查。
 */
function validateNode(
  key: string,
  node: NodeSchema,
  nodes: Readonly<Record<string, NodeSchema>>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  checkNodeIdentity(key, node, issues)
  checkNodeChildRefs(key, node, nodes, issues)
  checkAbsoluteRect(key, node, issues)

  return issues
}

/** 节点自身约束：键与 id 必须一致、componentName 必须非空 */
function checkNodeIdentity(key: string, node: NodeSchema, issues: ValidationIssue[]): void {
  if (node.id !== key) {
    issues.push({
      path: `/nodes/${key}/id`,
      message: `节点键 "${key}" 与节点 id "${node.id}" 不一致`,
      severity: 'error',
    })
  }

  if (!node.componentName) {
    issues.push({
      path: `/nodes/${key}/componentName`,
      message: '节点缺少 componentName',
      severity: 'error',
    })
  }
}

/** children 与 slots 引用的节点必须存在；断链一律 error，顺序先 children 后 slots */
function checkNodeChildRefs(
  key: string,
  node: NodeSchema,
  nodes: Readonly<Record<string, NodeSchema>>,
  issues: ValidationIssue[],
): void {
  for (const childId of node.children ?? []) {
    if (!nodes[childId]) {
      issues.push({
        path: `/nodes/${key}/children`,
        message: `子节点 "${childId}" 不存在`,
        severity: 'error',
      })
    }
  }

  for (const [slot, slotChildren] of Object.entries(node.slots ?? {})) {
    for (const childId of slotChildren) {
      if (!nodes[childId]) {
        issues.push({
          path: `/nodes/${key}/slots/${slot}`,
          message: `插槽节点 "${childId}" 不存在`,
          severity: 'error',
        })
      }
    }
  }
}

/** 绝对定位节点必须带 rect；缺失只 warning（流式布局节点本就允许没有 rect） */
function checkAbsoluteRect(key: string, node: NodeSchema, issues: ValidationIssue[]): void {
  if (node.layout?.mode === 'absolute' && !node.layout.rect) {
    issues.push({
      path: `/nodes/${key}/layout`,
      message: '绝对定位节点缺少 rect 几何信息',
      severity: 'warning',
    })
  }
}

/**
 * 根节点引用必须命中 nodes 表。
 *
 * 空节点表的情况已由调用方在更早的分支提前返回，这里只处理「表非空但根缺失」，
 * 故根 id 为空或指向不存在的节点都算断链。
 */
function checkRootNode(
  schema: PageSchema,
  nodes: Readonly<Record<string, NodeSchema>>,
  issues: ValidationIssue[],
): void {
  if (!schema.nodeId || !nodes[schema.nodeId]) {
    issues.push({
      path: '/nodeId',
      message: `根节点 "${schema.nodeId}" 不存在于 nodes 表中`,
      severity: 'error',
    })
  }
}

/**
 * 校验页面 schema 的结构一致性。
 *
 * 检查项：
 * - version / nodeId 必填
 * - nodeId 必须指向 nodes 表中存在的节点
 * - 节点表键与节点自身 id 必须一致
 * - children / slots 引用的节点必须存在
 * - 节点必须声明非空 componentName
 * - 动作表键与动作 id 必须一致、type 非空、fallback 策略带补救动作
 * - 动作引用的动作必须存在，且引用图无环
 * - 事件连接引用的动作与节点必须存在，同一事件不可被重复绑定
 *
 * 问题顺序即返回顺序（版本 → 动作 → 动作环 → 连接 → 孤儿动作 → 组件树），
 * 面板按此顺序展示，拆分检查项时不要改变产出顺序。
 *
 * @returns 问题列表；空数组表示结构合法。
 */
export function validateDocument(schema: PageSchema): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (!schema.version) {
    issues.push({ path: '/version', message: '缺少 schema 版本号', severity: 'error' })
  }

  const nodes = schema.nodes ?? {}
  const actions = schema.actions ?? {}

  // 事件连接引用的动作与节点都必须存在，且先于组件树校验：
  // 否则空页面会提前返回，把「连到已删除节点的事件」整体漏掉。
  const connections = validateConnections(schema.connections ?? {}, nodes, actions)
  // 孤儿判定要在闭包之后：只被 flow.sequence 引用的动作不算孤儿
  expandUsedActions(actions, connections.usedActions)

  issues.push(
    ...validateActions(actions),
    ...detectActionCycles(actions),
    ...connections.issues,
  )
  issues.push(...validateUnusedActions(actions, connections.usedActions))

  if (Object.keys(nodes).length === 0) {
    issues.push({ path: '/nodes', message: '节点表为空', severity: 'error' })
    return issues
  }

  checkRootNode(schema, nodes, issues)

  for (const [key, node] of Object.entries(nodes))
    issues.push(...validateNode(key, node, nodes))

  return issues
}

/** 是否存在阻断性问题。 */
export function hasBlockingIssue(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error')
}
