import { describe, expect, it } from 'vitest'
import type { ActionHandler, ActionRunResult, ActionStepRecord } from '@lc/contracts'
import type { ActionDeclaration, ExpressionScope } from '@lc/schema'
import { createExpression, isExpressionString } from '@lc/schema'
import { FLOW_HANDLERS, runActionChain } from '../src'
import { DEFAULT_STEP_LIMIT } from '../src/runner'

/**
 * 测试替身的求值规则。
 *
 * `{{ name }}` 一律解析为 `scope[name]`，name 不在作用域里就抛错。这样条件真假由
 * 作用域内容决定，而不是由一张和真实引擎无关的期望值表决定——「作用域每步重建」
 * 这类语义只有在前者之下才可测。求值本身的行为由 `service-expression` 的用例覆盖。
 */
function evaluateExpression(raw: string, scope: ExpressionScope): unknown {
  const name = raw.replace(/[{}]/g, '').trim()
  if (!(name in scope)) throw new Error(`作用域里没有变量 "${name}"`)

  return scope[name]
}

/** 测试替身输入 */
interface FakeInput {
  /** 动作表 */
  actions: readonly ActionDeclaration[]
  /** 处理器（内置控制流处理器总是装入）；同类型时覆盖内置 */
  handlers?: readonly ActionHandler[]
  /** 作用域工厂；缺省返回固定对象 */
  createScope?: () => ExpressionScope
  /** 执行环境是否已销毁 */
  isDisposed?: () => boolean
  stepLimit?: number
}

/**
 * 跑一条链，返回结果与全部步记录。
 *
 * @param actionIds 链上的动作 id
 * @param input 替身输入
 */
async function run(
  actionIds: readonly string[],
  input: FakeInput,
): Promise<{
  result: ActionRunResult
  steps: ActionStepRecord[]
}> {
  const table = new Map(input.actions.map((action) => [action.id, action]))
  const handlers = new Map<string, ActionHandler>()
  const steps: ActionStepRecord[] = []

  for (const handler of FLOW_HANDLERS) handlers.set(handler.type, handler)
  for (const handler of input.handlers ?? []) handlers.set(handler.type, handler)

  const scopeOf = input.createScope ?? (() => ({}))

  const result = await runActionChain(actionIds, {
    actionOf: (actionId) => table.get(actionId),
    handlerOf: (type) => handlers.get(type),
    createScope: scopeOf,
    evaluateCondition: (expression, scope) => evaluateExpression(expression.raw, scope),
    resolveValue: (value, scope) =>
      isExpressionString(value) ? evaluateExpression(value.raw, scope) : value,
    onStep: (record) => steps.push(record),
    isDisposed: input.isDisposed,
    stepLimit: input.stepLimit,
  })

  return { result, steps }
}

/** 造一个动作；只给 id 时落成一个被 `recordHandler` 认领的占位类型 */
function makeAction(overrides: Partial<ActionDeclaration> & { id: string }): ActionDeclaration {
  return { type: 'test.noop', config: {}, ...overrides }
}

/** 记录型处理器：把被调用的动作 id 依次推进 `calls` */
function recordHandler(calls: string[], type = 'test.noop'): ActionHandler {
  return {
    type,
    async execute({ action }) {
      calls.push(action.id)
    },
  }
}

/** 总是抛错的处理器 */
function throwingHandler(message: string, type = 'test.noop'): ActionHandler {
  return {
    type,
    async execute() {
      throw new Error(message)
    },
  }
}

describe('顺序与条件', () => {
  it('按 actionIds 的数组顺序执行', async () => {
    const calls: string[] = []

    const { result, steps } = await run(['a', 'b', 'c'], {
      actions: [makeAction({ id: 'a' }), makeAction({ id: 'b' }), makeAction({ id: 'c' })],
      handlers: [recordHandler(calls)],
    })

    expect(calls).toEqual(['a', 'b', 'c'])
    expect(result).toEqual({ status: 'completed', steps: 3 })
    expect(steps.map((step) => step.outcome)).toEqual(['success', 'success', 'success'])
  })

  it('空链直接完成', async () => {
    const { result, steps } = await run([], { actions: [] })

    expect(result).toEqual({ status: 'completed', steps: 0 })
    expect(steps).toEqual([])
  })

  it('condition 为假时跳过本动作，但不影响后续动作', async () => {
    const calls: string[] = []

    const { result, steps } = await run(['a', 'b'], {
      actions: [
        makeAction({ id: 'a', condition: createExpression('{{ off }}') }),
        makeAction({ id: 'b' }),
      ],
      handlers: [recordHandler(calls)],
      createScope: () => ({ off: false }),
    })

    expect(calls).toEqual(['b'])
    expect(result).toEqual({ status: 'completed', steps: 2 })
    expect(steps[0]).toMatchObject({ actionId: 'a', outcome: 'skipped', durationMs: 0 })
  })

  it('condition 引用不存在的变量时按失败处理，而不是静默当成假', async () => {
    const calls: string[] = []

    const { result, steps } = await run(['a', 'b'], {
      actions: [
        makeAction({ id: 'a', condition: createExpression('{{ typo }}') }),
        makeAction({ id: 'b' }),
      ],
      handlers: [recordHandler(calls)],
    })

    expect(calls).toEqual([])
    expect(result).toEqual({
      status: 'failed',
      steps: 1,
      actionId: 'a',
      message: '作用域里没有变量 "typo"',
    })
    expect(steps[0]?.outcome).toBe('failed')
  })

  it('作用域逐步重建，上一步写入的变量对本步条件可见', async () => {
    const store: Record<string, unknown> = {}
    const calls: string[] = []

    /**
     * 若执行器在链开始时把作用域快照一次，`guarded` 的条件会读到空作用域并抛
     * 「作用域里没有变量 count」，整条链以 failed 结束。这条断言因此能真正区分
     * 「每步重建」与「快照一次」两种实现。
     */
    const { result } = await run(['bump', 'guarded'], {
      actions: [
        makeAction({ id: 'bump', type: 'test.bump' }),
        makeAction({ id: 'guarded', condition: createExpression('{{ count }}') }),
      ],
      handlers: [
        recordHandler(calls),
        {
          type: 'test.bump',
          async execute() {
            store.count = 1
          },
        },
      ],
      createScope: () => ({ ...store }),
    })

    expect(calls).toEqual(['guarded'])
    expect(result.status).toBe('completed')
  })

  it('config 交给处理器前已完成解析', async () => {
    const seen: unknown[] = []

    await run(['echo'], {
      actions: [
        makeAction({
          id: 'echo',
          type: 'test.echo',
          config: { payload: createExpression('{{ v }}') },
        }),
      ],
      handlers: [
        {
          type: 'test.echo',
          async execute({ config }) {
            seen.push(config.payload)
          },
        },
      ],
      createScope: () => ({ v: 42 }),
    })

    expect(seen).toEqual([42])
  })
})

describe('失败策略', () => {
  it('默认 stop：中断整条链并带上失败动作', async () => {
    const calls: string[] = []

    const { result } = await run(['a', 'b'], {
      actions: [makeAction({ id: 'a', type: 'test.fail' }), makeAction({ id: 'b' })],
      handlers: [throwingHandler('boom', 'test.fail'), recordHandler(calls)],
    })

    expect(calls).toEqual([])
    expect(result).toEqual({ status: 'failed', steps: 1, actionId: 'a', message: 'boom' })
  })

  it('continue：忽略失败继续后续动作，链整体算完成', async () => {
    const calls: string[] = []

    const { result, steps } = await run(['a', 'b'], {
      actions: [
        makeAction({ id: 'a', type: 'test.fail', onError: 'continue' }),
        makeAction({ id: 'b' }),
      ],
      handlers: [throwingHandler('boom', 'test.fail'), recordHandler(calls)],
    })

    expect(calls).toEqual(['b'])
    expect(result).toEqual({ status: 'completed', steps: 2 })
    expect(steps[0]).toMatchObject({ outcome: 'failed', message: 'boom' })
  })

  it('fallback：执行补救动作后回到原链继续', async () => {
    const calls: string[] = []

    const { result } = await run(['a', 'tail'], {
      actions: [
        makeAction({
          id: 'a',
          type: 'test.fail',
          onError: 'fallback',
          fallbackActionId: 'rescue',
        }),
        makeAction({ id: 'rescue' }),
        makeAction({ id: 'tail' }),
      ],
      handlers: [throwingHandler('boom', 'test.fail'), recordHandler(calls)],
    })

    expect(calls).toEqual(['rescue', 'tail'])
    expect(result.status).toBe('completed')
  })

  it('fallback 但没写补救动作 id 时，失败原因里说明未指定', async () => {
    const { result } = await run(['a'], {
      actions: [makeAction({ id: 'a', type: 'test.fail', onError: 'fallback' })],
      handlers: [throwingHandler('boom', 'test.fail')],
    })

    expect(result).toEqual({
      status: 'failed',
      steps: 1,
      actionId: 'a',
      message: 'boom（未指定补救动作）',
    })
  })

  it('fallback 指向不存在的动作时，失败落在补救动作的缺失上', async () => {
    /**
     * 原始失败文案仍能在步记录里读到（`a` 那条 `failed`），结果里报的是
     * 「补救动作不存在」——那才是用户需要去修的地方。
     */
    const { result, steps } = await run(['a'], {
      actions: [
        makeAction({
          id: 'a',
          type: 'test.fail',
          onError: 'fallback',
          fallbackActionId: 'gone',
        }),
      ],
      handlers: [throwingHandler('boom', 'test.fail')],
    })

    expect(result).toEqual({
      status: 'failed',
      steps: 1,
      actionId: 'gone',
      message: '动作 "gone" 不存在',
    })
    expect(steps[0]).toMatchObject({ actionId: 'a', outcome: 'failed', message: 'boom' })
  })

  it('未注册的动作类型算失败', async () => {
    const { result } = await run(['a'], {
      actions: [makeAction({ id: 'a', type: 'test.unknown' })],
    })

    expect(result).toMatchObject({
      status: 'failed',
      actionId: 'a',
      message: '未注册的动作类型 "test.unknown"',
    })
  })

  it('链上引用了不存在的动作 id 时算失败且不产生步记录', async () => {
    const { result, steps } = await run(['ghost'], { actions: [] })

    expect(result).toMatchObject({ status: 'failed', actionId: 'ghost', steps: 0 })
    expect(steps).toEqual([])
  })
})

describe('flow.condition 的 if/else 语义', () => {
  /** gate 分派到 yes / no，链尾还有一个 tail 用来验证「分支执行后回到原链」 */
  const actions = [
    makeAction({
      id: 'gate',
      type: 'flow.condition',
      config: {
        expression: createExpression('{{ ok }}'),
        trueActionId: 'yes',
        falseActionId: 'no',
      },
    }),
    makeAction({ id: 'yes' }),
    makeAction({ id: 'no' }),
    makeAction({ id: 'tail' }),
  ]

  it('条件成立走 true 分支，之后回到原链继续执行 tail', async () => {
    const calls: string[] = []

    const { result } = await run(['gate', 'tail'], {
      actions,
      handlers: [recordHandler(calls)],
      createScope: () => ({ ok: true }),
    })

    expect(calls).toEqual(['yes', 'tail'])
    expect(result.status).toBe('completed')
  })

  it('条件不成立走 false 分支，之后同样回到原链', async () => {
    const calls: string[] = []

    await run(['gate', 'tail'], {
      actions,
      handlers: [recordHandler(calls)],
      createScope: () => ({ ok: false }),
    })

    expect(calls).toEqual(['no', 'tail'])
  })

  it('分支目标缺省时等价于空操作', async () => {
    const calls: string[] = []

    const { result } = await run(['gate', 'tail'], {
      actions: [
        makeAction({
          id: 'gate',
          type: 'flow.condition',
          config: { expression: createExpression('{{ ok }}') },
        }),
        makeAction({ id: 'tail' }),
      ],
      handlers: [recordHandler(calls)],
      createScope: () => ({ ok: true }),
    })

    expect(calls).toEqual(['tail'])
    expect(result.status).toBe('completed')
  })

  it('分支里的动作嵌套深度为 1，且按完成顺序先于父动作上报', async () => {
    /**
     * 步记录是**完成顺序**：`gate` 的成功记录要等它的分支跑完才产生，所以内层
     * 动作先出现。`depth` 字段就是为了让消费方能把这个线性序列还原成树。
     */
    const { steps } = await run(['gate'], {
      actions: [
        makeAction({
          id: 'gate',
          type: 'flow.condition',
          config: { expression: createExpression('{{ ok }}'), trueActionId: 'yes' },
        }),
        makeAction({ id: 'yes' }),
      ],
      createScope: () => ({ ok: true }),
    })

    expect(steps.map((step) => [step.actionId, step.depth])).toEqual([
      ['yes', 1],
      ['gate', 0],
    ])
  })
})

describe('flow.sequence 与 flow.end', () => {
  it('flow.sequence 按成员顺序执行', async () => {
    const calls: string[] = []

    const { result } = await run(['group'], {
      actions: [
        makeAction({ id: 'group', type: 'flow.sequence', config: { actionIds: ['x', 'y'] } }),
        makeAction({ id: 'x' }),
        makeAction({ id: 'y' }),
      ],
      handlers: [recordHandler(calls)],
    })

    expect(calls).toEqual(['x', 'y'])
    expect(result.status).toBe('completed')
  })

  it('序列里的 flow.end 停掉整条链，而不只是子序列', async () => {
    const calls: string[] = []

    const { result } = await run(['group', 'tail'], {
      actions: [
        makeAction({
          id: 'group',
          type: 'flow.sequence',
          config: { actionIds: ['x', 'stop'] },
        }),
        makeAction({ id: 'x' }),
        makeAction({ id: 'stop', type: 'flow.end' }),
        makeAction({ id: 'tail' }),
      ],
      handlers: [recordHandler(calls)],
    })

    expect(calls).toEqual(['x'])
    expect(result).toEqual({ status: 'stopped', steps: 3 })
  })

  it('顶层 flow.end 让链以 stopped 结束', async () => {
    const calls: string[] = []

    const { result } = await run(['a', 'stop', 'b'], {
      actions: [
        makeAction({ id: 'a' }),
        makeAction({ id: 'stop', type: 'flow.end' }),
        makeAction({ id: 'b' }),
      ],
      handlers: [recordHandler(calls)],
    })

    expect(calls).toEqual(['a'])
    expect(result).toEqual({ status: 'stopped', steps: 2 })
  })

  it('actionIds 不是数组时报错，而不是静默跳过整组', async () => {
    const { result } = await run(['group'], {
      actions: [makeAction({ id: 'group', type: 'flow.sequence', config: { actionIds: 'x' } })],
    })

    expect(result).toMatchObject({
      status: 'failed',
      actionId: 'group',
      message: 'flow.sequence 的 actionIds 必须是动作 id 数组',
    })
  })
})

describe('执行器兜底', () => {
  /**
   * 自引用处理器：模拟「校验看不见、执行器必须拦住」的环。
   *
   * 这里刻意不用 `flow.condition`，而是自带一个无条件回跳 `loop` 的处理器——
   * `flow.condition` 的引用是静态可查的，`validate.ts` 的环检测会先拦下，
   * 用它测步数上限会测成两层重复。
   */
  const loopingHandler: ActionHandler = {
    type: 'test.loop',
    async execute({ runAction }) {
      return runAction('loop')
    },
  }

  function selfLoop(input: { stepLimit?: number; isDisposed?: () => boolean } = {}) {
    return run(['loop'], {
      actions: [makeAction({ id: 'loop', type: 'test.loop' })],
      handlers: [loopingHandler],
      ...input,
    })
  }

  it('动作引用成环时在步数上限处停下，而不是跑死主线程', async () => {
    const { result, steps } = await selfLoop({ stepLimit: 5 })

    expect(result).toEqual({ status: 'aborted', steps: 5, reason: 'step-limit' })
    expect(steps).toHaveLength(5)
  })

  it('缺省上限取 DEFAULT_STEP_LIMIT', async () => {
    const { result, steps } = await selfLoop()

    expect(result).toEqual({
      status: 'aborted',
      steps: DEFAULT_STEP_LIMIT,
      reason: 'step-limit',
    })
    expect(steps).toHaveLength(DEFAULT_STEP_LIMIT)
  })

  it('执行环境销毁后不再推进后续动作', async () => {
    let disposed = false
    const calls: string[] = []

    const { result } = await run(['a', 'b'], {
      actions: [makeAction({ id: 'a' }), makeAction({ id: 'b' })],
      handlers: [
        {
          type: 'test.noop',
          async execute({ action }) {
            calls.push(action.id)
            if (action.id === 'a') disposed = true
          },
        },
      ],
      isDisposed: () => disposed,
    })

    expect(calls).toEqual(['a'])
    expect(result).toEqual({ status: 'aborted', steps: 1, reason: 'disposed' })
  })
})
