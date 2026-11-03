import type { ActionRunResult, ActionOutcome } from '@lc/contracts'
import { ACTION_CONTINUE, ACTION_STOP } from '@lc/contracts'
import type { FlowDefinition, FlowEdge } from '@lc/schema'
import {
  FLOW_BRANCH_FALSE,
  FLOW_BRANCH_TRUE,
  FLOW_CONDITION,
  FLOW_PARALLEL,
  FLOW_SWITCH,
  buildFlowAdjacency,
  findFlowTriggers,
  flowOutEdges,
} from '@lc/schema'
import { createStepEngine, DEFAULT_STEP_LIMIT, toRunResult } from './step-engine'
import type { ActionRunnerDeps, RunState } from './step-engine'

/**
 * 流程图执行器。
 *
 * 与事件链执行器共用步进引擎（见 `step-engine.ts`），差别只在选路：链按下标，图按出边。
 * 因此条件跳过、失败三档处置、步数上限、逐步记录这些行为在两种形态里是同一套，
 * 不会出现「链里失败会停，图里失败悄悄继续」。
 *
 * ## 选路规则
 *
 * - `flow.condition` / `flow.switch`：不跑处理器，只求值 `config.expression`，
 *   按结果的分支标记挑出边。挑不到出边时本次执行走到尽头，结果记为 `completed`——
 *   「这条分支什么都没做」是合法答案，不是错误。
 * - `flow.parallel`：跑处理器（空操作，只为留一条日志），随后并发推进所有出边，
 *   并发度受 `settings.maxConcurrency` 限制。
 * - 其余节点：跑处理器后按出边 id 顺序串行推进。
 *
 * ## 三条必须知道的边界
 *
 * 1. **每个节点一次执行至多跑一次**。菱形汇聚因此天然只执行一次，代价是回边不成立
 *    （图本身要求无环，见 `flow-graph.ts`）。
 * 2. **汇聚节点由先到达的分支执行，不等待其它分支**。真正的 join 屏障需要入度计数，
 *    且要回答「某条分支永远不会到达时怎么办」，本轮未实现。
 * 3. **`flow.end` 停的是整张图**，包括仍在跑的并行分支——它的协议含义是「提前终止当前
 *    链」，映射到图上就是终止本次执行，而不是只掐掉当前这条路径。
 */

/** 图执行器依赖；`actionOf` 由本模块按节点表实现，调用方不必重复一遍 */
export type FlowGraphRunnerDeps = Omit<ActionRunnerDeps, 'actionOf'>

/** 条件节点的求值结果折算成分支标记 */
function conditionBranch(value: unknown): string {
  return value ? FLOW_BRANCH_TRUE : FLOW_BRANCH_FALSE
}

/** 多分支节点的求值结果折算成分支标记；对象与数组按 JSON 文本比较，其余走 String */
function switchBranch(value: unknown): string {
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)

  return String(value)
}

/**
 * 执行一张流程图。
 *
 * 本函数**不抛错**：流程失败不应该把触发它的事件分派一起带崩，失败信息通过返回值
 * 与 `onStep` 暴露。没有触发节点的图直接返回 `failed`——它不可能被事件唤起，
 * 静默返回「成功跑了 0 步」会让调试面板显示成一条空记录，看不出问题在哪。
 *
 * @param flow 待执行的流程图
 * @param deps 执行器依赖（作用域、处理器表、条件求值与配置解析）
 * @returns 执行结果；`steps` 为产生记录的步数（含跳过与失败）
 */
export async function runFlowGraph(
  flow: FlowDefinition,
  deps: FlowGraphRunnerDeps,
): Promise<ActionRunResult> {
  const state: RunState = { steps: 0, budget: deps.stepLimit ?? DEFAULT_STEP_LIMIT }
  const engine = createStepEngine({ ...deps, actionOf: (id) => flow.nodes[id] }, state)
  const adjacency = buildFlowAdjacency(flow)
  const visited = new Set<string>()

  const timeoutSeconds = flow.settings.timeoutSeconds
  // 非正数表示不设限：试运行时经常要停在断点式的人工观察上，超时反而挡路
  const deadline =
    timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : Number.POSITIVE_INFINITY

  /** 被 `flow.end` 或失败置位后，所有路径都不再推进 */
  let halted = false

  async function visit(nodeId: string, depth: number): Promise<void> {
    if (halted || visited.has(nodeId) || engine.halted()) return

    if (Date.now() > deadline) {
      state.aborted = 'timeout'
      return
    }

    const node = flow.nodes[nodeId]
    if (!node) return
    visited.add(nodeId)

    const outEdges = flowOutEdges(adjacency, nodeId)
    let successors = outEdges

    if (node.type === FLOW_CONDITION || node.type === FLOW_SWITCH) {
      const route = await engine.evaluateRoute(nodeId, depth)
      if (!route.ok) {
        halted = halted || engine.halted()
        return
      }

      const branch =
        node.type === FLOW_CONDITION ? conditionBranch(route.value) : switchBranch(route.value)
      successors = outEdges.filter((edge) => edge.branch === branch)
    } else {
      const outcome: ActionOutcome = await engine.runNode(nodeId, depth)
      if (outcome.kind === 'stop') {
        halted = true
        return
      }
    }

    if (successors.length === 0) return

    if (node.type === FLOW_PARALLEL) {
      await runConcurrently(successors, depth + 1)
      return
    }

    for (const edge of successors) {
      if (halted || engine.halted()) return
      await visit(edge.target, depth + 1)
    }
  }

  /**
   * 受限并发推进多条分支。
   *
   * 用游标 + 固定数量工作协程而不是 `Promise.all(edges.map(...))`：后者会把扇出全部
   * 同时铺开，一条 200 分支的并行节点会一次申请 200 个待办，而下游多半是同一个
   * 服务。上限来自 `settings.maxConcurrency`，至少保留 1 以免配置成 0 时分支全丢。
   */
  async function runConcurrently(edges: readonly FlowEdge[], depth: number): Promise<void> {
    const limit = Math.max(1, Math.floor(flow.settings.maxConcurrency) || 1)
    let cursor = 0

    async function worker(): Promise<void> {
      while (cursor < edges.length && !halted && !engine.halted()) {
        const index = cursor
        cursor += 1
        await visit(edges[index].target, depth)
      }
    }

    await Promise.all(Array.from({ length: Math.min(limit, edges.length) }, worker))
  }

  const trigger = findFlowTriggers(flow)[0]
  if (!trigger) {
    return {
      status: 'failed',
      steps: 0,
      actionId: flow.id,
      message: `流程 "${flow.id}" 没有触发节点，无法确定从哪开始执行`,
    }
  }

  await visit(trigger.id, 0)

  return toRunResult(state, halted ? ACTION_STOP : ACTION_CONTINUE)
}
