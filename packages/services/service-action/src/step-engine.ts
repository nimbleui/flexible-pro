import type {
  ActionHandler,
  ActionOutcome,
  ActionRunResult,
  ActionStepRecord,
} from '@lc/contracts'
import { ACTION_CONTINUE, ACTION_STOP } from '@lc/contracts'
import type { ActionDeclaration, ExpressionScope, ExpressionString } from '@lc/schema'
import { isExpressionString } from '@lc/schema'

/**
 * 动作步进引擎。
 *
 * 「一个动作怎么跑」这件事只有一份实现：条件跳过、处理器查找、失败三档处置、
 * 步数上限、销毁检查、逐步记录。事件链执行器（`runner.ts`）与流程图执行器
 * （`flow-runner.ts`）的差别只在**按什么顺序挑下一个动作**——前者按下标，
 * 后者按出边——所以把选路留在各自文件里，把执行语义抽到这里共用。
 */

/** 单条链允许的动作执行次数上限。
 *
 * 页面事件链正常在几十个动作内结束，200 已经足够宽松；它挡的是「动作引用成环
 * 后把主线程跑死」。设计期校验本应先拦住环（`validate.ts` 的 `detectActionCycles`、
 * `flow-graph.ts` 的 `detectFlowCycles`），这里兜住两种校验看不见的情况：未校验直接
 * 执行的 schema，以及自定义动作在自己的 `config` 里引用别的动作 id。
 */
export const DEFAULT_STEP_LIMIT = 200

/** 执行器依赖；全部由调用方注入，使引擎可以脱离内核与 DOM 单独测试 */
export interface ActionRunnerDeps {
  /** 按 id 取动作声明；流程图执行器传的是「按节点 id 取节点」 */
  actionOf(actionId: string): ActionDeclaration | undefined
  /** 按类型取处理器 */
  handlerOf(type: string): ActionHandler | undefined
  /**
   * 构造本步的表达式作用域。
   *
   * 必须是**每步重新调用**而不是整条链快照一次：`state.set` 之后，
   * 后续动作的条件要能读到新值。
   */
  createScope(): ExpressionScope
  /**
   * 求值条件表达式。
   *
   * 实现方应使用**会抛错**的求值路径（`compile(...).evaluate(scope)`）：「条件写错了」
   * 与「条件为假」必须可区分，否则表达式里的拼写错误会静默变成一条永远不执行的分支。
   */
  evaluateCondition(expression: ExpressionString, scope: ExpressionScope): unknown
  /** 解析配置值；表达式与模板求值，非表达式原样返回 */
  resolveValue(value: unknown, scope: ExpressionScope): unknown
  /** 每执行完一步通知；跳过的动作同样通知 */
  onStep?(record: ActionStepRecord): void
  /**
   * 执行环境是否已销毁。
   *
   * 每步推进前查询一次。必须查的原因：`dataSource.fetch` 这类处理器会 `await` 真实
   * 请求，用户可能在等待期间关掉文档——此时后续步骤仍会推进，写进一个已经没有主人的
   * 状态服务。省略这个检查会让「关闭页面后再回来的请求」继续产生副作用。
   *
   * @returns 已销毁时返回 true
   * @default () => false
   */
  isDisposed?(): boolean
  /**
   * 步数上限。
   *
   * @default DEFAULT_STEP_LIMIT
   */
  stepLimit?: number
}

/** 一次执行的可变态；收在引擎里，调用方只读不写 */
export interface RunState {
  steps: number
  budget: number
  /**
   * 被强制中止的原因；优先级高于 failure 与 stopped。
   *
   * `timeout` 只有流程图执行器会写：链式模型没有流程级时限，图有
   * `FlowSettings.timeoutSeconds`。
   */
  aborted?: 'step-limit' | 'disposed' | 'timeout'
  failure?: { actionId: string; message: string }
}

/** 路由节点（条件 / 多分支）的判定结果 */
export type RouteOutcome =
  | {
      /** 判别位：判定完成，调用方按 `value` 选边 */
      ok: true
      /** 表达式求值结果，由调用方折算成分支标记 */
      value: unknown
    }
  /** 判别位：判定失败或已中止，本次执行不应继续推进 */
  | { ok: false }

/** 步进引擎对外能力 */
export interface ActionStepEngine {
  /**
   * 执行一个动作，含条件判断、处理器调用与失败处置。
   *
   * @param actionId 动作或流程节点 id
   * @param depth 嵌套深度；顶层为 0
   * @returns 对当前执行流的影响
   */
  runNode(actionId: string, depth: number): Promise<ActionOutcome>
  /**
   * 按数组顺序走完一串动作；任一动作返回 `stop` 即停止推进。
   *
   * @param actionIds 待执行的动作 id 列表
   * @param depth 嵌套深度
   */
  runNodes(actionIds: readonly string[], depth: number): Promise<ActionOutcome>
  /**
   * 求值路由节点的 `config.expression` 并记录这一步。
   *
   * 路由节点没有处理器：它存在的意义就是决定走哪条出边，选边逻辑属于调用方。
   * 求值抛错按该节点的失败处置（走 `onError`），与「条件为假」严格区分。
   *
   * @param actionId 路由节点 id
   * @param depth 嵌套深度
   * @returns 判定结果；失败或已中止时为 `{ ok: false }`
   */
  evaluateRoute(actionId: string, depth: number): Promise<RouteOutcome>
  /**
   * 执行是否已不可继续。
   *
   * @returns 步数超限、失败中止或环境销毁时返回 true
   */
  halted(): boolean
}

/** 把 `ActionHandler.execute` 的 `void` 返回归一化为「继续」 */
function toOutcome(outcome: ActionOutcome | void): ActionOutcome {
  return outcome ?? ACTION_CONTINUE
}

/** 把任意抛出的值收敛成一句可读的失败原因 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 逐键解析动作 config；整体交给 `resolveValue` 会丢掉键的类型信息 */
function resolveConfig(
  deps: ActionRunnerDeps,
  config: Record<string, unknown>,
  scope: ExpressionScope,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(config)) {
    resolved[key] = deps.resolveValue(value, scope)
  }

  return resolved
}

/**
 * 创建步进引擎。
 *
 * @param deps 执行器依赖
 * @param state 本次执行的可变态；由调用方创建，便于执行完成后折算成结果对象
 * @returns 引擎实例
 */
export function createStepEngine(deps: ActionRunnerDeps, state: RunState): ActionStepEngine {
  /**
   * 记录并广播一步的结果。
   *
   * 步数在这里自增，因此**每个被访问到的动作恰好有一条记录**：跳过与失败也算，
   * 否则调试面板会把「什么都没发生」显示成「链很短」。
   */
  function record(
    action: ActionDeclaration,
    depth: number,
    startedAt: number,
    outcome: ActionStepRecord['outcome'],
    message?: string,
  ): void {
    state.steps += 1
    deps.onStep?.({
      actionId: action.id,
      type: action.type,
      outcome,
      message,
      durationMs: outcome === 'skipped' ? 0 : performance.now() - startedAt,
      depth,
    })
  }

  /**
   * 推进一步前的三道检查：环境已销毁、步数超限、动作是否存在。
   *
   * @returns 可以继续时返回动作声明，否则返回 undefined 并已写好中止原因
   */
  function beginStep(actionId: string): ActionDeclaration | undefined {
    if (state.aborted) return undefined

    if (deps.isDisposed?.()) {
      state.aborted = 'disposed'
      return undefined
    }

    if (--state.budget < 0) {
      state.aborted = 'step-limit'
      return undefined
    }

    const action = deps.actionOf(actionId)
    if (!action) {
      state.failure = { actionId, message: `动作 "${actionId}" 不存在` }
      return undefined
    }

    return action
  }

  /**
   * 按动作的 `onError` 策略处置一次失败。
   *
   * `continue` 不写入 `state.failure`：调用方已明确表示忽略这次失败，链跑完后的结果
   * 就该是 `completed`；错误文案只通过步记录暴露。
   *
   * @param startedAt 本动作的开始时刻，由调用点带入而不是在这里重新取——失败同样要
   *   记录真实耗时，否则「跑了两秒后失败」会显示成 0ms。
   */
  async function handleFailure(
    action: ActionDeclaration,
    depth: number,
    startedAt: number,
    message: string,
  ): Promise<ActionOutcome> {
    record(action, depth, startedAt, 'failed', message)

    if (action.onError === 'continue') return ACTION_CONTINUE

    if (action.onError === 'fallback') {
      if (!action.fallbackActionId) {
        state.failure = { actionId: action.id, message: `${message}（未指定补救动作）` }
        return ACTION_STOP
      }

      return runNode(action.fallbackActionId, depth + 1)
    }

    state.failure = { actionId: action.id, message }
    return ACTION_STOP
  }

  async function runNode(actionId: string, depth: number): Promise<ActionOutcome> {
    const action = beginStep(actionId)
    if (!action) return ACTION_STOP

    const startedAt = performance.now()
    const scope = deps.createScope()

    if (action.condition) {
      let passed: unknown
      try {
        passed = deps.evaluateCondition(action.condition, scope)
      } catch (error) {
        return handleFailure(action, depth, startedAt, describeError(error))
      }

      if (!passed) {
        record(action, depth, startedAt, 'skipped')
        return ACTION_CONTINUE
      }
    }

    const handler = deps.handlerOf(action.type)
    if (!handler) {
      return handleFailure(action, depth, startedAt, `未注册的动作类型 "${action.type}"`)
    }

    try {
      const outcome = toOutcome(
        await handler.execute({
          action,
          config: resolveConfig(deps, action.config, scope),
          scope,
          runAction: (refId) => runNode(refId, depth + 1),
        }),
      )

      record(action, depth, startedAt, 'success')
      return outcome
    } catch (error) {
      return handleFailure(action, depth, startedAt, describeError(error))
    }
  }

  async function runNodes(actionIds: readonly string[], depth: number): Promise<ActionOutcome> {
    for (const id of actionIds) {
      const outcome = await runNode(id, depth)
      if (outcome.kind === 'stop') return outcome
    }

    return ACTION_CONTINUE
  }

  async function evaluateRoute(actionId: string, depth: number): Promise<RouteOutcome> {
    const action = beginStep(actionId)
    if (!action) return { ok: false }

    const startedAt = performance.now()
    const expression = action.config.expression

    if (!isExpressionString(expression)) {
      await handleFailure(action, depth, startedAt, '分支条件未填写或不是 {{ }} 表达式')
      return { ok: false }
    }

    try {
      const value = deps.evaluateCondition(expression, deps.createScope())
      record(action, depth, startedAt, 'success', String(value))
      return { ok: true, value }
    } catch (error) {
      await handleFailure(action, depth, startedAt, describeError(error))
      return { ok: false }
    }
  }

  return {
    runNode,
    runNodes,
    evaluateRoute,
    halted: () => state.aborted !== undefined || state.failure !== undefined,
  }
}

/**
 * 把执行过程的可变态折算成对外的结果判别联合。
 *
 * 优先级：中止 > 失败 > 停止 > 完成。中止与失败都已盖过链的正常走向；剩下要区分的是
 * 「自己走到了末尾」还是「被 `flow.end` 提前掐断」——两者都没出错，但对调试面板
 * 是两件不同的事。
 *
 * @param state 执行完成后的可变态
 * @param outcome 最后一步的走向
 * @returns 对外结果
 */
export function toRunResult(state: RunState, outcome: ActionOutcome): ActionRunResult {
  const { steps } = state

  if (state.aborted) return { status: 'aborted', steps, reason: state.aborted }
  if (state.failure) return { status: 'failed', steps, ...state.failure }

  return outcome.kind === 'stop' ? { status: 'stopped', steps } : { status: 'completed', steps }
}
