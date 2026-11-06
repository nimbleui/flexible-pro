import type { ExpressionRef } from '@lc/expression/editor'
import { listExpressionRefs } from '@lc/expression/editor'
import type { NodeSchema, PageSchema } from '@lc/schema'
import { childRefs, isExpressionString, isJsExpression } from '@lc/schema'

/** 绑定落在哪个位置类别上；决定表格的分组标签 */
export type BindingKind =
  'prop' | 'condition' | 'loop' | 'directive' | 'style' | 'key' | 'action'

/** 一条动态绑定 */
export interface PageBinding {
  /** 画布上的节点 id；动作绑定不属于任何节点，因此可以缺省 */
  nodeId?: string
  /** 扫描时算好的展示名，面板不再回头查 schema */
  nodeLabel: string
  /** 位置标识，如 `props.text`、`condition`、`actions[act-1].config.url` */
  field: string
  kind: BindingKind
  /** 表达式原文 */
  expression: string
  /**
   * 表达式形态，决定诊断与引用提取怎么读这段文本。
   *
   * 整值绑定与混排插值在 schema 里长得一样（都是字符串），但 `{{ a }}` 作为整值
   * 是表达式、作为文案是模板，读错的后果是「明明写对了却报语法错」。
   */
  mode: 'expression' | 'template'
  /**
   * 白名单之外的原生 JS 片段。
   *
   * `JsExpression` 是宿主受信逃生门，白名单解析器读不了它，所以不产出引用。
   * 面板据此显示「原生代码」而不是「没有引用」——两者含义相反。
   */
  unsafe: boolean
  /** 静态可确定的作用域引用 */
  refs: readonly ExpressionRef[]
}

/** 一个表达式槽位：位置已知，引用还没算 */
interface RawSlot {
  nodeId?: string
  nodeLabel?: string
  field: string
  kind: BindingKind
  expression: string
  /** 引用提取的输入形态，与 `listExpressionRefs` 同一套 */
  mode: 'expression' | 'template'
  unsafe: boolean
}

/** 引用了未声明数据项的一条绑定 */
export interface UnresolvedRef {
  /** 缺失的 `data` 下第一段名字 */
  name: string
  /** 引用到的完整路径，如 `data.token` */
  path: string
  binding: PageBinding
}

/** 没有任何绑定引用的数据项 */
export interface UnusedData {
  /** 数据项名字 */
  name: string
  /** 是变量还是接口数据 */
  kind: 'variable' | 'source'
}

/**
 * 递归收集一个 schema 值里的表达式槽位。
 *
 * 属性值可能是整值绑定（`{ type: 'expression', raw }`）、混排插值（`共 {{ n }} 项`），
 * 也可能把两者埋进数组与对象里。渲染器走的是 `resolveValue` 的同一套递归规则，
 * 这里必须按同样的顺序展开，否则面板列出的绑定和画布上真正生效的不是同一批。
 */
function collectSlots(value: unknown, field: string, kind: BindingKind, out: RawSlot[]): void {
  if (isExpressionString(value)) {
    out.push({ field, kind, expression: value.raw, mode: 'expression', unsafe: false })
    return
  }

  if (isJsExpression(value)) {
    out.push({ field, kind, expression: value.code, mode: 'expression', unsafe: true })
    return
  }

  if (typeof value === 'string') {
    const isTemplate = value.includes('{{')
    if (isTemplate)
      out.push({ field, kind, expression: value, mode: 'template', unsafe: false })
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSlots(item, `${field}[${index}]`, kind, out))
    return
  }

  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectSlots(item, `${field}.${key}`, kind, out)
    }
  }
}

/** 节点上全部可动态求值的位置 */
function scanNode(node: NodeSchema, out: RawSlot[]): void {
  for (const [key, value] of Object.entries(node.props ?? {})) {
    collectSlots(value, `props.${key}`, 'prop', out)
  }

  if (node.condition !== undefined) collectSlots(node.condition, 'condition', 'condition', out)

  if (node.loop) {
    collectSlots(node.loop.dataSource, 'loop.dataSource', 'loop', out)
    if (node.loop.key !== undefined) collectSlots(node.loop.key, 'loop.key', 'loop', out)
  }

  node.directives?.forEach((directive, index) => {
    collectSlots(directive.condition, `directives[${index}].condition`, 'directive', out)
  })

  if (node.style) collectSlots(node.style, 'style', 'style', out)
  if (node.key !== undefined) collectSlots(node.key, 'key', 'key', out)
}

/**
 * 页面级动作的表达式槽位。
 *
 * 动作 config 与 condition 都会读 `data`，所以「某个数据项没被任何绑定引用」这条
 * 结论必须把它们算进来，否则事件里正在用的数据会被误报成死数据。
 * 函数体不在范围内：`PageSchema.functions` 的契约是纯函数，只看得见形参。
 */
function scanActions(schema: PageSchema, out: RawSlot[]): void {
  for (const action of Object.values(schema.actions ?? {})) {
    const before = out.length
    collectSlots(action.config ?? {}, `actions[${action.id}].config`, 'action', out)
    if (action.condition !== undefined) {
      collectSlots(action.condition, `actions[${action.id}].condition`, 'action', out)
    }
    const label = action.name || action.type
    for (const slot of out.slice(before)) slot.nodeLabel = label
  }
}

/**
 * 从根节点开始的可渲染顺序。
 *
 * 表格按渲染顺序排列才能和图层树对上；游离节点（父引用已删但节点还在）补在后面，
 * 保证它们不会因为「遍历不到」而从面板上凭空消失。
 */
function orderedNodes(schema: PageSchema): NodeSchema[] {
  const ordered: NodeSchema[] = []
  const visited = new Set<string>()

  function visit(id: string): void {
    if (visited.has(id)) return
    visited.add(id)

    const node = schema.nodes[id]
    if (!node) return
    ordered.push(node)
    for (const child of childRefs(node)) visit(child)
  }

  visit(schema.nodeId)
  for (const node of Object.values(schema.nodes)) visit(node.id)
  return ordered
}

/**
 * 扫描整页的动态绑定。
 *
 * @param schema 页面 schema
 * @returns 先按渲染顺序列出节点绑定，再列页面级动作绑定
 */
export function scanPageBindings(schema: PageSchema): PageBinding[] {
  const slots: RawSlot[] = []

  for (const node of orderedNodes(schema)) {
    const before = slots.length
    scanNode(node, slots)

    const label = node.name || node.componentName || node.id
    for (const slot of slots.slice(before)) {
      slot.nodeLabel = label
      slot.nodeId = node.id
    }
  }

  scanActions(schema, slots)

  return slots
    .filter((slot) => slot.expression.trim() !== '')
    .map((slot) => ({
      nodeId: slot.nodeId,
      nodeLabel: slot.nodeLabel ?? '',
      field: slot.field,
      kind: slot.kind,
      expression: slot.expression,
      mode: slot.mode,
      unsafe: slot.unsafe,
      refs: slot.unsafe ? [] : listExpressionRefs(slot.expression, slot.mode),
    }))
}

/** `data.<名字>` 里的那一段名字；不是 data 根引用时返回 undefined */
function dataItemName(ref: ExpressionRef): string | undefined {
  if (ref.root !== 'data' || ref.path === 'data') return undefined
  return ref.path.split('.')[1]
}

/**
 * 找出引用了未声明数据项的绑定。
 *
 * 只校验 `data` 根：`$route` / `$params` / `event` 由宿主注入，循环形参只在局部作用域里，
 * 设计期都没有稳定的声明源可查。裸标识符写错（`{{ counnt }}`）也不在这里报——
 * 表达式引擎本来就会按 unbound-identifier 上报诊断，重复报一遍只会让两处口径打架。
 */
export function findUnresolvedRefs(
  bindings: readonly PageBinding[],
  schema: PageSchema,
): UnresolvedRef[] {
  const declared = declaredDataNames(schema)
  const issues: UnresolvedRef[] = []

  for (const binding of bindings) {
    for (const ref of binding.refs) {
      const name = dataItemName(ref)
      if (name === undefined || declared.has(name)) continue
      issues.push({ name, path: ref.path, binding })
    }
  }

  return issues
}

/**
 * 找出没有任何绑定引用的数据项。
 *
 * 判据是静态路径命中：`data.users` 与 `data.users.data` 都算引用了 users。
 * 出现动态下标（`data[key]`）时整体跳过本项检查——静态分析到此为止，
 * 宁可少报，也不把正在使用的数据说成死数据。
 */
export function findUnusedData(
  bindings: readonly PageBinding[],
  schema: PageSchema,
): UnusedData[] {
  const used = new Set<string>()

  for (const binding of bindings) {
    for (const ref of binding.refs) {
      if (ref.dynamic && ref.root === 'data') return []
      const name = dataItemName(ref)
      if (name !== undefined) used.add(name)
    }
  }

  const unused: UnusedData[] = []
  for (const variable of schema.variables ?? []) {
    if (!used.has(variable.name)) unused.push({ name: variable.name, kind: 'variable' })
  }
  for (const source of schema.datasources ?? []) {
    if (!used.has(source.id)) unused.push({ name: source.id, kind: 'source' })
  }
  return unused
}

/** 变量与接口数据共用的 `data` 命名空间名字 */
export function declaredDataNames(schema: PageSchema): Set<string> {
  const names = new Set<string>()
  for (const variable of schema.variables ?? []) names.add(variable.name)
  for (const source of schema.datasources ?? []) names.add(source.id)
  return names
}

/**
 * 引用了某个作用域路径的绑定。
 *
 * 按路径前缀匹配而不是按名字：`data.users` 与 `data.users.data` 都算引用了 users，
 * 但 `data.userScore` 不算——所以比较时始终带上 `.` 边界，避免同名前缀误判。
 */
export function bindingsReferencing(
  bindings: readonly PageBinding[],
  path: string,
): PageBinding[] {
  return bindings.filter((binding) =>
    binding.refs.some((ref) => ref.path === path || ref.path.startsWith(`${path}.`)),
  )
}

/** 位置类别的中文标签；表格里显示，不暴露内部 kind */
export const BINDING_KIND_LABELS: Record<BindingKind, string> = {
  prop: '属性',
  condition: '条件渲染',
  loop: '循环',
  directive: '指令',
  style: '样式',
  key: '键值',
  action: '动作',
}
