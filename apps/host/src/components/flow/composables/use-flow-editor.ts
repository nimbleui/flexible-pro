import { computed, ref, shallowRef } from 'vue'
import type { Point } from '@lc/contracts'
import type {
  FlowDefinition,
  FlowEdge,
  FlowNode,
  FlowSettings,
  ValidationIssue,
} from '@lc/schema'
import { createFlowNode, validateFlow } from '@lc/schema'
import {
  getFlow,
  nextEdgeId,
  nextNodeId,
  publishFlow,
  saveFlow,
} from '../../../workflows/flow-store'
import { visibleInProject } from '../../../projects/project-model'

/**
 * 流程编辑器的文档工作副本。
 *
 * 视图不直接改 store 里的对象：改动先落在一份本地副本上，用户点「保存草稿」才写回
 * 存储。这样误操作不会污染已发布的图，也让撤销栈只需要管一个对象。
 *
 * ## 为什么用快照而不是 patch
 *
 * `@lc/schema` 的 patch 路径是为 `PageSchema` 设计的（`/nodes/<id>/layout/rect`），
 * 流程图是另一份文档，套过去要么改 patch 层要么伪造一个 document 服务。一张图的
 * 体量在几十节点量级，克隆一次的成本远低于引入一层类型体操；执行器与校验读的都是
 * 完整对象，快照式历史与它们天然一致。
 */

/** 一次连线请求被拒绝的原因 */
export type FlowEdgeRejection =
  /** 两端是同一个节点 */
  | 'self'
  /** 两端之间已经有一条同向连线 */
  | 'duplicate'
  /** 任一端节点已不在图上，含工作副本不存在 */
  | 'missing-node'

/**
 * `addEdge` 的结果。
 *
 * 只返回 `FlowEdge | undefined` 时，画布分不清「被规则拒绝」与「没有可连的对象」，
 * 只能静默吞掉；作者看到的是线弹回去，而不是「为什么不行」。
 */
export type AddFlowEdgeResult =
  { ok: true; edge: FlowEdge } | { ok: false; reason: FlowEdgeRejection }

/** 深拷贝工作副本；`structuredClone` 保留 `undefined` 字段，JSON 往返会抹掉它们 */
function cloneFlow(flow: FlowDefinition): FlowDefinition {
  return structuredClone(flow)
}

/**
 * 建流程编辑器的工作副本。
 *
 * `projectId` 参与取图：A 项目的图挂到 B 项目的 URL 上时按「图不存在」处理，
 * 不让 B 的编辑器改到 A 的内容；视图已有的 `missing` 提示正好覆盖这一种。
 */
export function useFlowEditor(flowId: string, projectId: string) {
  const stored = visibleInProject(getFlow(flowId), projectId)

  /** 工作副本；整对象替换，因此用 shallowRef 避免 Vue 深入代理每个节点 */
  const working = shallowRef<FlowDefinition | undefined>(stored ? cloneFlow(stored) : undefined)
  /** 最近一次写回存储的内容，用于脏判定 */
  const savedSnapshot = shallowRef<FlowDefinition | undefined>(
    stored ? cloneFlow(stored) : undefined,
  )

  /**
   * 撤销 / 重做栈。
   *
   * 必须是 `shallowRef` 而不是 `ref`：`ref` 会把数组元素也变成响应式代理，而 `undo`
   * 取出的那份快照会被写回 `working`，下一次编辑 `structuredClone(代理)` 直接抛
   * DataCloneError——表现是「撤销一次之后整个编辑器就再也不动了」。
   * 栈本身的变化靠整体替换触发，`canUndo` / `canRedo` 仍然能读到。
   */
  const past = shallowRef<FlowDefinition[]>([])
  const future = shallowRef<FlowDefinition[]>([])
  const gestureBase = shallowRef<FlowDefinition | null>(null)

  const selectedNodeId = ref<string | null>(null)
  const selectedEdgeId = ref<string | null>(null)

  const flow = computed(() => working.value)

  const missing = computed(() => working.value === undefined)

  const issues = computed<ValidationIssue[]>(() =>
    working.value ? validateFlow(working.value) : [],
  )

  const blockingIssues = computed(() =>
    issues.value.filter((issue) => issue.severity === 'error'),
  )

  const dirty = computed(() => {
    if (!working.value) return false
    if (!savedSnapshot.value) return true

    return JSON.stringify(working.value) !== JSON.stringify(savedSnapshot.value)
  })

  const canUndo = computed(() => past.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)

  /** 选中项可能因撤销或删除而消失，每次写入后统一收敛 */
  function reconcileSelection(): void {
    const current = working.value
    if (!current) {
      selectedNodeId.value = null
      selectedEdgeId.value = null
      return
    }

    if (selectedNodeId.value && !current.nodes[selectedNodeId.value])
      selectedNodeId.value = null
    if (selectedEdgeId.value && !current.edges[selectedEdgeId.value])
      selectedEdgeId.value = null
  }

  function write(next: FlowDefinition): void {
    working.value = next
    reconcileSelection()
  }

  /** 开始一段连续写入；嵌套调用只保留最外层基线 */
  function beginGesture(): void {
    if (gestureBase.value || !working.value) return
    gestureBase.value = cloneFlow(working.value)
  }

  /** 结束一段连续写入；内容没变时不留历史，避免「点了一下没拖动」也进栈 */
  function endGesture(): void {
    const base = gestureBase.value
    gestureBase.value = null
    if (!base || !working.value) return
    if (JSON.stringify(base) === JSON.stringify(working.value)) return

    past.value = [...past.value, base]
    future.value = []
  }

  /**
   * 只写副本、不入历史。
   *
   * 供手势内部的高频更新使用：拖动一次节点会产生几十次 pointermove，每次都入栈会让
   * 撤销变成「退回上一像素」。历史边界由 `beginGesture` / `endGesture` 决定。
   */
  function patch(mutate: (draft: FlowDefinition) => void): void {
    if (!working.value) return

    const draft = cloneFlow(working.value)
    mutate(draft)
    write(draft)
  }

  /**
   * 一次性改动：自动包住手势边界。
   *
   * @param mutate 由当前副本算出新副本；直接改传入对象是允许的，因为它已是克隆体
   */
  function apply(mutate: (draft: FlowDefinition) => void): void {
    if (!working.value) return

    beginGesture()
    patch(mutate)
    endGesture()
  }

  function undo(): void {
    const current = working.value
    const previous = past.value[past.value.length - 1]
    if (!current || !previous) return

    past.value = past.value.slice(0, -1)
    future.value = [...future.value, cloneFlow(current)]
    write(previous)
  }

  function redo(): void {
    const current = working.value
    const next = future.value[future.value.length - 1]
    if (!current || !next) return

    future.value = future.value.slice(0, -1)
    past.value = [...past.value, cloneFlow(current)]
    write(next)
  }

  function selectNode(nodeId: string | null): void {
    selectedNodeId.value = nodeId
    // 节点与连线是两套配置表单，互斥选中比同时选中少一个「右栏显示哪个」的歧义
    if (nodeId) selectedEdgeId.value = null
  }

  function selectEdge(edgeId: string | null): void {
    selectedEdgeId.value = edgeId
    if (edgeId) selectedNodeId.value = null
  }

  const selectedNode = computed<FlowNode | undefined>(() => {
    const id = selectedNodeId.value

    return id ? working.value?.nodes[id] : undefined
  })

  const selectedEdge = computed<FlowEdge | undefined>(() => {
    const id = selectedEdgeId.value

    return id ? working.value?.edges[id] : undefined
  })

  /**
   * 从节点库落一个节点。
   *
   * @param catalogKey 节点库条目 key
   * @param position 落点世界坐标（左上角）
   * @returns 新节点；工作副本不存在时返回 undefined
   * @throws catalogKey 不在节点库中时由 `createFlowNode` 抛错
   */
  function addNode(catalogKey: string, position: Point): FlowNode | undefined {
    if (!working.value) return undefined

    const node = createFlowNode(catalogKey, nextNodeId(working.value), position)
    apply((draft) => {
      draft.nodes[node.id] = node
    })
    selectNode(node.id)

    return working.value?.nodes[node.id]
  }

  /**
   * 移动节点。
   *
   * 不入历史：它是给拖动用的逐帧写入，一次拖动的历史边界由调用方的
   * `beginGesture` / `endGesture` 提供。
   */
  function moveNode(nodeId: string, position: Point): void {
    patch((draft) => {
      const node = draft.nodes[nodeId]
      if (!node) return
      node.position = { x: position.x, y: position.y }
    })
  }

  /** 改节点的顶层字段（名称、说明、失败策略、映射） */
  function updateNode(nodeId: string, patch: Partial<Omit<FlowNode, 'id' | 'type'>>): void {
    apply((draft) => {
      const node = draft.nodes[nodeId]
      if (!node) return
      Object.assign(node, patch)
    })
  }

  /**
   * 改节点配置里的一个键。
   *
   * `value` 为 `undefined` 时删除该键而不是写入 undefined：校验把「没有这个键」和
   * 「值为空串」都当作未填，但持久化里留一堆 `key: undefined` 会让 JSON diff 噪声很大。
   */
  function updateNodeConfig(nodeId: string, key: string, value: unknown): void {
    apply((draft) => {
      const node = draft.nodes[nodeId]
      if (!node) return

      if (value === undefined) delete node.config[key]
      else node.config[key] = value
    })
  }

  /** 删除节点，并连带删掉它的全部出入边 */
  function removeNode(nodeId: string): void {
    apply((draft) => {
      delete draft.nodes[nodeId]

      for (const [edgeId, edge] of Object.entries(draft.edges)) {
        if (edge.source === nodeId || edge.target === nodeId) delete draft.edges[edgeId]
      }
    })
  }

  /**
   * 连接两个节点。
   *
   * 自环与重复连线都拒绝：两者会被 `validateFlow` 判成 error，但让作者在拉线时
   * 得不到反馈、要到发布才发现，比不允许多一次操作更糟。因此拒绝必须带出原因，
   * 由画布转成一句可见提示。
   *
   * @returns 成功带出新连线，失败带出原因
   */
  function addEdge(source: string, target: string): AddFlowEdgeResult {
    const current = working.value
    if (!current) return { ok: false, reason: 'missing-node' }
    if (source === target) return { ok: false, reason: 'self' }
    if (!current.nodes[source] || !current.nodes[target]) {
      return { ok: false, reason: 'missing-node' }
    }

    const duplicated = Object.values(current.edges).some(
      (edge) => edge.source === source && edge.target === target,
    )
    if (duplicated) return { ok: false, reason: 'duplicate' }

    const edge: FlowEdge = { id: nextEdgeId(current), source, target }
    apply((draft) => {
      draft.edges[edge.id] = edge
    })
    selectEdge(edge.id)

    return { ok: true, edge }
  }

  /**
   * 改连线属性。
   *
   * 只开放 `label` 与 `branch`：`source` / `target` 改了等于换了一条边，应该删掉重连，
   * 否则历史里会出现「同一条 id 指向两个不同节点对」的状态，小地图与执行记录都会对不上。
   */
  function updateEdge(edgeId: string, patch: { label?: string; branch?: string }): void {
    apply((draft) => {
      const edge = draft.edges[edgeId]
      if (!edge) return

      if ('label' in patch) edge.label = patch.label
      if ('branch' in patch) edge.branch = patch.branch
    })
  }

  function removeEdge(edgeId: string): void {
    apply((draft) => {
      delete draft.edges[edgeId]
    })
  }

  function updateSettings(patch: Partial<FlowSettings>): void {
    apply((draft) => {
      Object.assign(draft.settings, patch)
    })
  }

  function updateMeta(patch: { name?: string; description?: string }): void {
    apply((draft) => {
      if (patch.name !== undefined) draft.name = patch.name
      if (patch.description !== undefined) draft.description = patch.description || undefined
    })
  }

  /** 写回存储；名称为空时由 store 抛错，调用方负责展示 */
  function saveDraft(): FlowDefinition | undefined {
    if (!working.value) return undefined

    const saved = saveFlow(working.value)
    working.value = cloneFlow(saved)
    savedSnapshot.value = cloneFlow(saved)

    return saved
  }

  /**
   * 发布。
   *
   * 先过本地校验再交给 store：store 也会校验，但面板需要的是「哪几个问题」而不是
   * 一句错误文案，所以这里把阻断项一次性取出来给调用方展示。
   *
   * @throws store 的发布校验失败时抛错（事件占用冲突等本地看不出的情况）
   */
  function publish(): { ok: boolean; issues: ValidationIssue[]; flow?: FlowDefinition } {
    if (!working.value) return { ok: false, issues: [] }
    if (blockingIssues.value.length > 0) {
      return { ok: false, issues: blockingIssues.value }
    }

    const published = publishFlow(working.value.id)
    working.value = cloneFlow(published)
    savedSnapshot.value = cloneFlow(published)

    return { ok: true, issues: [], flow: published }
  }

  return {
    flow,
    missing,
    dirty,
    issues,
    blockingIssues,
    canUndo,
    canRedo,
    undo,
    redo,
    selectedNodeId,
    selectedEdgeId,
    selectedNode,
    selectedEdge,
    selectNode,
    selectEdge,
    beginGesture,
    endGesture,
    patch,
    addNode,
    moveNode,
    updateNode,
    updateNodeConfig,
    removeNode,
    addEdge,
    updateEdge,
    removeEdge,
    updateSettings,
    updateMeta,
    saveDraft,
    publish,
  }
}

/** 编辑器状态句柄类型，供各面板按 props 接收而不是重新 inject */
export type FlowEditorHandle = ReturnType<typeof useFlowEditor>
