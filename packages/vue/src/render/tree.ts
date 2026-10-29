import type { NodeSchema, PageSchema, Rect } from '@lc/schema'

/** 渲染树节点：属性已求值、条件与指令已应用 */
export interface RenderNode {
  /** 渲染 key；循环实例带 `#index` 后缀 */
  key: string
  /** 原始 schema 节点 */
  node: NodeSchema
  /** 世界矩形 */
  rect: Rect
  /** 已求值的属性 */
  props: Record<string, unknown>
  /** 子节点（children + slots 扁平） */
  children: RenderNode[]
  /** 是否可见（directives show/hide） */
  visible: boolean
  /** 是否禁用（directives disabled） */
  disabled: boolean
}

/** 渲染树构建选项 */
export interface RenderTreeOptions {
  /** 页面 schema */
  schema: PageSchema
  /** 初始作用域（如 data / page） */
  scope?: Record<string, unknown>
  /** 值求值器：表达式、模板插值、嵌套对象解析由宿主注入 */
  resolveValue(value: unknown, scope: Record<string, unknown>): unknown
  /** 最大递归深度，防止循环引用拖垮渲染 @default 24 */
  maxDepth?: number
}

const DEFAULT_RECT: Rect = { x: 0, y: 0, width: 100, height: 40 }

function childRefs(node: NodeSchema): string[] {
  return [...(node.children ?? []), ...Object.values(node.slots ?? {}).flat()]
}

/**
 * 构建渲染树。
 *
 * 规则：
 * - `condition` 为假时整棵子树不渲染
 * - `directives` 的 show/hide/disabled 生效于节点自身
 * - `loop` 展开为多个实例（同一世界矩形；流式布局属于后续能力），
 *   作用域注入 `$item/$index`（或自定义名）
 * - 同一节点只渲染一次（父级优先），循环实例除外
 * - 未被任何节点引用的节点作为顶层孤儿渲染，兼容旧文档
 */
export function buildRenderTree(options: RenderTreeOptions): RenderNode[] {
  const { schema, resolveValue } = options
  const rootScope = options.scope ?? {}
  const maxDepth = options.maxDepth ?? 24
  const rendered = new Set<string>()

  const referenced = new Set<string>()
  for (const node of Object.values(schema.nodes)) {
    for (const ref of childRefs(node)) referenced.add(ref)
  }

  function evaluate(value: unknown, scope: Record<string, unknown>): unknown {
    if (value === undefined || value === null) return undefined
    return resolveValue(value, scope)
  }

  function directivesOf(
    node: NodeSchema,
    scope: Record<string, unknown>,
  ): { visible: boolean; disabled: boolean } {
    let visible = true
    let disabled = false

    for (const directive of node.directives ?? []) {
      if (!evaluate(directive.condition, scope)) continue
      if (directive.type === 'show') visible = true
      else if (directive.type === 'hide') visible = false
      else if (directive.type === 'disabled') disabled = true
    }

    return { visible, disabled }
  }

  function propsOf(node: NodeSchema, scope: Record<string, unknown>): Record<string, unknown> {
    if (!node.props) return {}
    const resolved: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node.props)) {
      resolved[key] = resolveValue(value, scope)
    }
    return resolved
  }

  function makeNode(
    node: NodeSchema,
    scope: Record<string, unknown>,
    key: string,
    depth: number,
    path: Set<string>,
    flags: { visible: boolean; disabled: boolean },
  ): RenderNode {
    const children: RenderNode[] = []
    for (const childId of childRefs(node)) {
      children.push(...build(childId, scope, `${key}/${childId}`, depth + 1, path))
    }

    return {
      key,
      node,
      rect: node.layout?.rect ? { ...node.layout.rect } : DEFAULT_RECT,
      props: propsOf(node, scope),
      children,
      visible: flags.visible,
      disabled: flags.disabled,
    }
  }

  function build(
    nodeId: string,
    scope: Record<string, unknown>,
    key: string,
    depth: number,
    path: Set<string>,
  ): RenderNode[] {
    if (depth > maxDepth) return []

    const node = schema.nodes[nodeId]
    if (!node) return []
    if (path.has(nodeId)) return []

    const nextPath = new Set(path).add(nodeId)
    if (node.condition !== undefined && !evaluate(node.condition, scope)) return []
    // hidden 属于设计态开关：整棵子树不渲染、不参与命中
    if (node.hidden) return []

    const flags = directivesOf(node, scope)
    const loop = node.loop ? evaluate(node.loop.dataSource, scope) : undefined
    if (node.loop && Array.isArray(loop)) {
      rendered.add(nodeId)
      const itemName = node.loop.itemName ?? '$item'
      const indexName = node.loop.indexName ?? '$index'
      return loop.map((item, index) =>
        makeNode(
          node,
          { ...scope, [itemName]: item, [indexName]: index },
          `${key}#${index}`,
          depth,
          nextPath,
          flags,
        ),
      )
    }

    if (rendered.has(nodeId)) return []
    rendered.add(nodeId)

    return [makeNode(node, scope, key, depth, nextPath, flags)]
  }

  const tree = build(schema.nodeId, rootScope, schema.nodeId, 0, new Set())

  for (const nodeId of Object.keys(schema.nodes)) {
    if (nodeId === schema.nodeId) continue
    if (rendered.has(nodeId)) continue
    if (referenced.has(nodeId)) continue

    tree.push(...build(nodeId, rootScope, nodeId, 0, new Set()))
  }

  return tree
}
