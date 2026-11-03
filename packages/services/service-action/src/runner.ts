import type { ActionOutcome, ActionRunResult } from '@lc/contracts'
import { createStepEngine, DEFAULT_STEP_LIMIT, toRunResult } from './step-engine'
import type { ActionRunnerDeps, RunState } from './step-engine'

/**
 * 事件链执行器。
 *
 * 执行语义（条件跳过、失败三档处置、步数上限、逐步记录）都在 `step-engine.ts`，
 * 本文件只回答「下一个执行谁」：按下标顺序走完 `actionIds`。
 */

export type { ActionRunnerDeps } from './step-engine'
export { DEFAULT_STEP_LIMIT } from './step-engine'

/**
 * 执行一条动作链。
 *
 * 语义约定（与 `packages/schema/src/actions.ts` 的协议注释一致）：
 * - 顺序即 `actionIds` 的数组顺序；
 * - `condition` 为假时**跳过本动作、继续后续动作**，跳过不触发 `onError`；
 * - `condition` 求值抛错时按本动作失败处理；
 * - `flow.condition` 执行完选中分支后**回到原链继续**，要提前结束用 `flow.end`；
 * - 失败按 `onError` 处置，默认 `stop` 中断整条链。
 *
 * 本函数**不抛错**：一条链失败不应该把触发它的组件渲染一起带崩，所有失败信息
 * 通过返回值与 `onStep` 暴露。
 *
 * @param actionIds 链上的动作 id，即 `EventConnection.actionIds`
 * @param deps 执行器依赖
 * @returns 链的执行结果；`steps` 为产生记录的步数（含跳过与失败）
 */
export async function runActionChain(
  actionIds: readonly string[],
  deps: ActionRunnerDeps,
): Promise<ActionRunResult> {
  const state: RunState = { steps: 0, budget: deps.stepLimit ?? DEFAULT_STEP_LIMIT }
  const engine = createStepEngine(deps, state)

  const outcome: ActionOutcome = await engine.runNodes(actionIds, 0)

  return toRunResult(state, outcome)
}
