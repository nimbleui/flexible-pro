import type { LoopConfig, NodeSchema, PageSchema, Rect } from '@lc/schema'

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
  /**
   * 待渲染的节点图。
   *
   * 只声明 `buildRenderTree` 实际读取的两个字段，而不是整份 PageSchema：
   * 复合组件的蓝图与预览用的临时文档同样只有节点表，凑出页面级字段
   * （version / metadata / components）只会造出假数据。
   */
  schema: Pick<PageSchema, 'nodeId' | 'nodes'>
  /** 初始作用域（如 data / page） */
  scope?: Record<string, unknown>
  /** 值求值器：表达式、模板插值、嵌套对象解析由宿主注入 */
  resolveValue(value: unknown, scope: Record<string, unknown>): unknown
  /** 最大递归深度，防止循环引用拖垮渲染 @default 24 */
  maxDepth?: number
}

const DEFAULT_RECT: Rect = { x: 0, y: 0, width: 100, height: 40 }

/** 指令求值结果，作用于节点自身而非子树 */
interface NodeFlags {
  /** show / hide 后的最终可见性；hidden 节点在上游已整棵跳过，不经过这里 */
  visible: boolean
  /** disabled 指令是否生效；由渲染层决定是置灰还是仅标记状态 */
  disabled: boolean
}

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

  function evaluate(value: unknown, scope: Record<string, unknown>): unknown {
    if (value === undefined || value === null) return undefined
    return resolveValue(value, scope)
  }

  /**
   * 求值节点自身的显隐 / 禁用指令。
   *
   * 按数组顺序逐条覆盖，因此同类型指令的后写者生效；未被任何指令命中的轴保持
   * 默认值（可见、可交互），不返回 null 之类的中间态。
   */
  function directivesOf(node: NodeSchema, scope: Record<string, unknown>): NodeFlags {
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

  /**
   * 循环实例的作用域。
   *
   * 注入名默认 `$item` / `$index`，可被 `loop.itemName` / `indexName` 改写；
   * 每次迭代都新建一层普通对象，实例之间不共享绑定，父级作用域按值展开。
   */
  function loopScope(
    scope: Record<string, unknown>,
    loop: LoopConfig,
    item: unknown,
    index: number,
  ): Record<string, unknown> {
    return { ...scope, [loop.itemName ?? '$item']: item, [loop.indexName ?? '$index']: index }
  }

  function makeNode(
    node: NodeSchema,
    scope: Record<string, unknown>,
    key: string,
    depth: number,
    path: Set<string>,
    flags: NodeFlags,
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
    const loopInstances = expandLoop(nodeId, node, scope, key, depth, nextPath, flags)
    if (loopInstances) return loopInstances

    if (rendered.has(nodeId)) return []
    rendered.add(nodeId)

    return [makeNode(node, scope, key, depth, nextPath, flags)]
  }

  /**
   * 循环节点按数据源展开成多实例；非循环、或数据源求值不是数组时返回 null，
   * 交回单实例路径（此时节点不计入 rendered，仍可能被孤儿兜底渲染）。
   */
  function expandLoop(
    nodeId: string,
    node: NodeSchema,
    scope: Record<string, unknown>,
    key: string,
    depth: number,
    path: Set<string>,
    flags: NodeFlags,
  ): RenderNode[] | null {
    const loop = node.loop
    if (!loop) return null

    const loopItems = evaluate(loop.dataSource, scope)
    if (!Array.isArray(loopItems)) return null

    // 循环节点整体计入 rendered：子树已按实例展开，孤儿兜底不该再渲染一次
    rendered.add(nodeId)

    return loopItems.map((item, index) =>
      makeNode(
        node,
        loopScope(scope, loop, item, index),
        `${key}#${index}`,
        depth,
        path,
        flags,
      ),
    )
  }

  /** 顶层组装：先建根子树，再把「未引用、未渲染」的孤儿补进结果，兼容旧文档游离节点 */
  function renderTopLevel(): RenderNode[] {
    const tree = build(schema.nodeId, rootScope, schema.nodeId, 0, new Set())

    // referenced 延后到根构建之后才收集：build 只依赖 rendered / path，孤儿兜底与它
    // 无关，延后既不改变遍历顺序，也不改变 rendered 的填充时机。
    const referenced = new Set<string>()
    for (const node of Object.values(schema.nodes)) {
      for (const ref of childRefs(node)) referenced.add(ref)
    }

    for (const nodeId of Object.keys(schema.nodes)) {
      if (nodeId === schema.nodeId) continue
      if (rendered.has(nodeId)) continue
      if (referenced.has(nodeId)) continue

      tree.push(...build(nodeId, rootScope, nodeId, 0, new Set()))
    }

    return tree
  }

  return renderTopLevel()
}
