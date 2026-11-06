import type { NodeSchema, PageSchema } from '@lc/schema'

/**
 * 设计态标记视图。
 *
 * `hidden` / `locked` 写在单个节点上，但语义是沿树继承的：隐藏或锁定一个容器，
 * 它的整棵子树同样不可见 / 不可变换。画布上的命中、变换与图层树都需要这套结论，
 * 所以统一在这里从 schema 推导一次，避免各处各自 parent-walk 出不同结果。
 */
export interface NodeFlagView {
  /** 自身或某个祖先被隐藏的节点 */
  hidden: ReadonlySet<string>
  /** 自身或某个祖先被锁定的节点 */
  locked: ReadonlySet<string>
  /**
   * 画幅根节点 id，即 `PageSchema.nodeId`；没有文档时为 null。
   *
   * 根不是「画幅上的一个物件」而是画幅本身：它没有父级坐标系可以放置，`layout.rect`
   * 的含义是页面尺寸与原点（视口 fit、小地图、舞台框都读它）。所以它永远不是移动 /
   * 缩放 / 旋转 / 对齐的作用对象，只作为吸附参照、投放父级和被选中的属性编辑目标参与画布。
   * 逐帧谓词（图层 visible、手柄包围盒）读这里，避免每帧重新遍历文档。
   */
  root: string | null
}

/** 子节点引用：children 与全部具名插槽，顺序不影响推导结果 */
function childIds(node: NodeSchema): string[] {
  const slots = Object.values(node.slots ?? {}).flat()
  return [...(node.children ?? []), ...slots]
}

/**
 * 从文档根节点向下推导隐藏 / 锁定集合。
 *
 * 沿引用遍历一遍即可，代价 O(节点数)；`visited` 同时兜住环引用与重复引用，
 * 保证坏文档不会让递归转不完。根节点自身没有父级，只按自己的标记计算。
 */
export function resolveNodeFlags(schema: PageSchema): NodeFlagView {
  const hidden = new Set<string>()
  const locked = new Set<string>()
  const visited = new Set<string>()

  const walk = (nodeId: string, parentHidden: boolean, parentLocked: boolean): void => {
    if (visited.has(nodeId)) return
    const node = schema.nodes[nodeId]
    if (!node) return
    visited.add(nodeId)

    const selfHidden = parentHidden || node.hidden === true
    const selfLocked = parentLocked || node.locked === true
    if (selfHidden) hidden.add(nodeId)
    if (selfLocked) locked.add(nodeId)

    for (const child of childIds(node)) walk(child, selfHidden, selfLocked)
  }

  walk(schema.nodeId, false, false)

  // 未被根节点引用的游离节点（渲染器会兜底画出来）按自身标记参与判定
  for (const [nodeId, node] of Object.entries(schema.nodes)) {
    if (visited.has(nodeId)) continue
    if (node.hidden === true) hidden.add(nodeId)
    if (node.locked === true) locked.add(nodeId)
  }

  return { hidden, locked, root: schema.nodeId }
}

/** 空视图：文档缺失或尚未同步时的兜底，等价于「所有节点都可选、都可见、没有画幅根」 */
export const EMPTY_NODE_FLAGS: NodeFlagView = {
  hidden: new Set<string>(),
  locked: new Set<string>(),
  root: null,
}

/**
 * 取可参与几何变换的 id 子集。
 *
 * 变换类手势（拖拽 / 缩放 / 旋转 / 对齐 / 删除 / 微调）统一走这里：
 * 图层树允许选中锁定节点，所以不能假设选中集里每个 id 都能被改。
 * 画幅根同样被剔除——变换它等于改页面尺寸，那是页面设置而不是手势。
 * schema 里不存在的 id（选中集比文档新）一并剔除，避免 patch 写到空节点上。
 * 结果保持入参顺序，调用方据此计算组包围盒时不受排序影响。
 */
export function transformableIds(ids: readonly string[], schema: PageSchema): string[] {
  const { locked } = resolveNodeFlags(schema)
  return ids.filter(
    (id) => id !== schema.nodeId && !locked.has(id) && schema.nodes[id] !== undefined,
  )
}

/**
 * 取选中集里真正出得了变换手柄的那部分节点。
 *
 * 手柄的可见条件（图层 `visible`，每帧调用）与手柄框的包围基准必须给同一份答案，
 * 否则会出现「手柄框住了一整片改不动的区域」：选中画幅根、或选中集里混入锁定节点时，
 * 手势起始处都会把这些 id 过滤掉，画出来的框却在对侧。
 * 只查派生好的集合，不遍历文档，适合在渲染帧里调用。
 *
 * @param ids 当前选中集（画布帧快照里的只读数组）
 * @param flags 上一次文档同步派生的标记视图，提供画幅根 id 与锁定集合
 * @returns 剔除画幅根与锁定节点后的 id 列表，保持入参顺序
 */
export function handleTargetIds(ids: readonly string[], flags: NodeFlagView): string[] {
  return ids.filter((id) => id !== flags.root && !flags.locked.has(id))
}
