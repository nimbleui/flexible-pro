import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type {
  DocumentService,
  FlowService,
  MaterialService,
  SelectionService,
} from '@lc/contracts'
import type { ExpressionEngine, FunctionDescriptor, NodeSchema, SchemaPatch } from '@lc/schema'
import type { ScopeSymbol } from '@lc/expression/editor'
import { buildPageSymbols } from '@lc/expression/editor'
import { createPersistentId } from '@lc/shared'
import { useAppContext } from '@lc/vue'

/**
 * 面板共享底座：服务句柄、重算版本号，以及写入文档与生成 id 的唯一出口。
 *
 * 其余 composable 都通过它读写文档，避免每个切片各自 `ctx.get()` 并维护自己的订阅。
 */
export interface EventFlowStore {
  /** 文档服务句柄；面板未装配时为 undefined */
  document: DocumentService | undefined
  /** 选区服务句柄；面板未装配时为 undefined */
  selection: SelectionService | undefined
  /** 物料服务句柄；面板未装配时为 undefined */
  material: MaterialService | undefined
  /** 表达式引擎句柄；面板未装配时为 undefined */
  expression: ExpressionEngine | undefined
  /**
   * 流程图仓库；宿主没装时为 undefined，此时子流程候选为空。
   *
   * 事件流面板本身不执行图，只在下拉里列出可引用的已发布流程，所以它是可选依赖。
   */
  flow: FlowService | undefined
  /** 服务只用来触发重读，数据始终从服务实时取 */
  version: Ref<number>
  /** 页面数据符号供条件表达式补全；函数体仍然只能看到形参 */
  expressionSymbols: ComputedRef<ScopeSymbol[]>
  /** 表达式可用函数清单，供动作配置里的函数下拉 */
  expressionFunctions: ComputedRef<readonly FunctionDescriptor[]>
  /** 当前选中的节点 id，未选中为 undefined */
  selectedNodeId: ComputedRef<string | undefined>
  /** 当前选中的节点 schema，未选中为 undefined */
  selectedNode: ComputedRef<NodeSchema | undefined>
  /** 提交一批 schema 变更；空补丁不写入历史 */
  commit(patches: SchemaPatch[], label: string): void
  /** 取节点展示名：优先名称，回退组件名，再回退 id；节点已删除时给出提示 */
  nodeLabel(nodeId: string): string
  /** 生成不与现有键冲突的实例 id */
  nextId(prefix: string, taken: readonly string[]): string
}

/**
 * 创建事件流面板共享 store（状态形状见 {@link EventFlowStore}）。
 *
 * 其余事件流 composable 都经它读写文档，避免各自 `ctx.get()` 并维护独立订阅。
 */
export function useEventFlowStore(): EventFlowStore {
  const ctx = useAppContext()
  const document = ctx.get<DocumentService>('document')
  const selection = ctx.get<SelectionService>('selection')
  const material = ctx.get<MaterialService>('material')
  const expression = ctx.get<ExpressionEngine>('expression')
  const flow = ctx.get<FlowService>('flow')

  const version = ref(0)
  /** 挂载期注册的订阅；卸载时逐个释放，面板重挂不会叠加监听 */
  const disposables: Array<{
    /** 解绑这一条订阅，重复调用不安全，因此只在 onUnmounted 走一次 */
    dispose(): void
  }> = []

  function bump(): void {
    version.value += 1
  }

  onMounted(() => {
    if (document) disposables.push(document.onDidChange(bump))
    if (selection) disposables.push(selection.onDidChange(bump))
    if (material) disposables.push(material.onDidChange(bump))
    // 图的事件绑定存在图那一侧，改它不会动页面文档；不订阅就刷不出「这个事件上还挂着一张图」
    if (flow) disposables.push(flow.onDidChange(bump))
  })

  onUnmounted(() => {
    for (const disposable of disposables) disposable.dispose()
    disposables.length = 0
  })

  const expressionSymbols = computed(() => {
    version.value
    const schema = document?.model.schema
    return schema ? buildPageSymbols(schema) : []
  })

  const expressionFunctions = computed(() => {
    version.value
    return expression?.functions.describe() ?? []
  })

  const selectedNodeId = computed<string | undefined>(() => {
    version.value
    return selection?.primary
  })

  const selectedNode = computed<NodeSchema | undefined>(() => {
    const id = selectedNodeId.value
    return id ? document?.model.schema.nodes[id] : undefined
  })

  function commit(patches: SchemaPatch[], label: string): void {
    if (!document || patches.length === 0) return
    document.apply(patches, { record: true, label })
  }

  function nodeLabel(nodeId: string): string {
    const node = document?.model.schema.nodes[nodeId]
    if (!node) return `已删除节点 ${nodeId}`
    return node.name || node.componentName || node.id
  }

  /**
   * 新 id 自带跨端熵，但仍对文档内现有键查重：导入旧数据或测试夹具时，
   * 不能让新动作/新连接覆盖已有条目。
   */
  function nextId(prefix: string, taken: readonly string[]): string {
    const used = new Set(taken)
    let id = createPersistentId(prefix)
    while (used.has(id)) id = createPersistentId(prefix)
    return id
  }

  return {
    document,
    selection,
    material,
    expression,
    flow,
    version,
    expressionSymbols,
    expressionFunctions,
    selectedNodeId,
    selectedNode,
    commit,
    nodeLabel,
    nextId,
  }
}
