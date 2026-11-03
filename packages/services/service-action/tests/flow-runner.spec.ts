import { describe, expect, it } from 'vitest'
import type { ActionHandler, ActionRunResult, ActionStepRecord } from '@lc/contracts'
import type { ExpressionScope, FlowDefinition, FlowEdge, FlowNode } from '@lc/schema'
import {
  DEFAULT_FLOW_SETTINGS,
  FLOW_TRIGGER,
  createExpression,
  isExpressionString,
} from '@lc/schema'
import { FLOW_HANDLERS, runFlowGraph } from '../src'

/** 与 runner.spec 一致的替身求值：`{{ name }}` 读作用域，缺变量就抛错 */
function evaluateExpression(raw: string, scope: ExpressionScope): unknown {
  const name = raw.replace(/[{}]/g, '').trim()
  if (!(name in scope)) throw new Error(`作用域里没有变量 "${name}"`)

  return scope[name]
}

function makeTrigger(id = 't'): FlowNode {
  return {
    id,
    type: FLOW_TRIGGER,
    name: '开始',
    position: { x: 0, y: 0 },
    config: { kind: 'pageEvent', sourceNodeId: 'page', eventName: 'pageLoad' },
  }
}

function makeNode(id: string, type: string, config: Record<string, unknown> = {}): FlowNode {
  return { id, type, name: id, position: { x: 0, y: 0 }, config }
}

function makeEdge(id: string, source: string, target: string, branch?: string): FlowEdge {
  return branch === undefined ? { id, source, target } : { id, source, target, branch }
}

function makeFlow(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  settings: Partial<FlowDefinition['settings']> = {},
): FlowDefinition {
  return {
    id: 'flow-1',
    name: '测试流程',
    status: 'draft',
    version: '1.0.0',
    updatedAt: '2026-11-03T00:00:00.000Z',
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    edges: Object.fromEntries(edges.map((edge) => [edge.id, edge])),
    settings: { ...DEFAULT_FLOW_SETTINGS, ...settings },
  }
}

/** 记录触发顺序的处理器工厂；把执行顺序变成可断言的名字序列 */
function spyHandler(types: readonly string[]): ActionHandler[] {
  return types.map((type) => ({
    type,
    async execute() {
      executed.push(type)
    },
  }))
}

let executed: string[] = []

interface FakeInput {
  handlers?: readonly ActionHandler[]
  createScope?: () => ExpressionScope
  stepLimit?: number
}

async function run(
  flow: FlowDefinition,
  input: FakeInput = {},
): Promise<{ result: ActionRunResult; steps: ActionStepRecord[] }> {
  executed = []
  const handlers = new Map<string, ActionHandler>()
  const steps: ActionStepRecord[] = []

  for (const handler of FLOW_HANDLERS) handlers.set(handler.type, handler)
  for (const handler of input.handlers ?? []) handlers.set(handler.type, handler)

  const result = await runFlowGraph(flow, {
    handlerOf: (type) => handlers.get(type),
    createScope: input.createScope ?? (() => ({})),
    evaluateCondition: (expression, scope) => evaluateExpression(expression.raw, scope),
    resolveValue: (value, scope) =>
      isExpressionString(value) ? evaluateExpression(value.raw, scope) : value,
    onStep: (record) => steps.push(record),
    stepLimit: input.stepLimit,
  })

  return { result, steps }
}

/** 触发节点在测试里也走处理器，否则会被判成「未注册的动作类型」 */
const triggerHandler = (): ActionHandler => ({
  type: FLOW_TRIGGER,
  async execute() {
    executed.push('trigger')
  },
})

describe('流程图执行器', () => {
  it('按出边串行推进，每个节点一条记录', async () => {
    const flow = makeFlow(
      [makeTrigger(), makeNode('a', 'state.set'), makeNode('b', 'ui.toast')],
      [makeEdge('e1', 't', 'a'), makeEdge('e2', 'a', 'b')],
      {},
    )

    const { result, steps } = await run(flow, {
      handlers: [triggerHandler(), ...spyHandler(['state.set', 'ui.toast'])],
    })

    expect(result).toEqual({ status: 'completed', steps: 3 })
    expect(steps.map((step) => step.actionId)).toEqual(['t', 'a', 'b'])
    expect(executed).toEqual(['trigger', 'state.set', 'ui.toast'])
  })

  it('条件节点只执行选中分支，另一侧完全不跑', async () => {
    const flow = makeFlow(
      [
        makeTrigger(),
        makeNode('c', 'flow.condition', { expression: createExpression('{{ ok }}') }),
        makeNode('y', 'state.set'),
        makeNode('n', 'ui.toast'),
      ],
      [
        makeEdge('e1', 't', 'c'),
        makeEdge('e2', 'c', 'y', 'true'),
        makeEdge('e3', 'c', 'n', 'false'),
      ],
    )

    const { result, steps } = await run(flow, {
      handlers: [triggerHandler(), ...spyHandler(['state.set', 'ui.toast'])],
      createScope: () => ({ ok: true }),
    })

    // 触发 + 条件判定 + 成立分支 = 3 步，不成立分支连记录都没有
    expect(result).toEqual({ status: 'completed', steps: 3 })
    expect(steps.map((s) => s.actionId)).toEqual(['t', 'c', 'y'])
    expect(executed).toEqual(['trigger', 'state.set'])
  })

  it('条件为假时走另一侧，判定结果写进步记录', async () => {
    const flow = makeFlow(
      [
        makeTrigger(),
        makeNode('c', 'flow.condition', { expression: createExpression('{{ ok }}') }),
        makeNode('y', 'state.set'),
        makeNode('n', 'ui.toast'),
      ],
      [
        makeEdge('e1', 't', 'c'),
        makeEdge('e2', 'c', 'y', 'true'),
        makeEdge('e3', 'c', 'n', 'false'),
      ],
    )

    const { steps } = await run(flow, {
      handlers: [triggerHandler(), ...spyHandler(['state.set', 'ui.toast'])],
      createScope: () => ({ ok: false }),
    })

    expect(steps.find((s) => s.actionId === 'c')?.message).toBe('false')
    expect(executed).toEqual(['trigger', 'ui.toast'])
  })

  it('条件节点没有对应出边时正常收尾，不算失败', async () => {
    const flow = makeFlow(
      [
        makeTrigger(),
        makeNode('c', 'flow.condition', { expression: createExpression('{{ ok }}') }),
        makeNode('y', 'state.set'),
      ],
      [makeEdge('e1', 't', 'c'), makeEdge('e2', 'c', 'y', 'true')],
    )

    const { result } = await run(flow, {
      handlers: [triggerHandler(), ...spyHandler(['state.set'])],
      createScope: () => ({ ok: false }),
    })

    expect(result).toEqual({ status: 'completed', steps: 2 })
    expect(executed).toEqual(['trigger'])
  })

  it('多分支节点按求值结果匹配边', async () => {
    const flow = makeFlow(
      [
        makeTrigger(),
        makeNode('s', 'flow.switch', { expression: createExpression('{{ status }}') }),
        makeNode('paid', 'state.set'),
        makeNode('refund', 'ui.toast'),
      ],
      [
        makeEdge('e1', 't', 's'),
        makeEdge('e2', 's', 'paid', 'paid'),
        makeEdge('e3', 's', 'refund', 'refund'),
      ],
    )

    await run(flow, {
      handlers: [triggerHandler(), ...spyHandler(['state.set', 'ui.toast'])],
      createScope: () => ({ status: 'refund' }),
    })

    expect(executed).toEqual(['trigger', 'ui.toast'])
  })

  it('并行节点两条分支都执行，汇聚节点只跑一次', async () => {
    const flow = makeFlow(
      [
        makeTrigger(),
        makeNode('p', 'flow.parallel'),
        makeNode('left', 'state.set'),
        makeNode('right', 'ui.toast'),
        makeNode('join', 'navigation.go'),
      ],
      [
        makeEdge('e1', 't', 'p'),
        makeEdge('e2', 'p', 'left'),
        makeEdge('e3', 'p', 'right'),
        makeEdge('e4', 'left', 'join'),
        makeEdge('e5', 'right', 'join'),
      ],
    )

    const { result, steps } = await run(flow, {
      handlers: [triggerHandler(), ...spyHandler(['state.set', 'ui.toast', 'navigation.go'])],
    })

    expect(result.status).toBe('completed')
    expect(steps.filter((s) => s.actionId === 'join')).toHaveLength(1)
    expect([...executed].sort()).toEqual(['navigation.go', 'state.set', 'trigger', 'ui.toast'])
  })

  it('并发上限为 1 时分支按边序串行，不会同时铺开', async () => {
    const order: string[] = []
    const slow: ActionHandler[] = ['state.set', 'ui.toast'].map((type, index) => ({
      type,
      async execute() {
        order.push(`${type}:enter`)
        await new Promise((resolve) => setTimeout(resolve, index === 0 ? 20 : 0))
        order.push(`${type}:exit`)
      },
    }))

    const flow = makeFlow(
      [
        makeTrigger(),
        makeNode('p', 'flow.parallel'),
        makeNode('a', 'state.set'),
        makeNode('b', 'ui.toast'),
      ],
      [makeEdge('e1', 't', 'p'), makeEdge('e2', 'p', 'a'), makeEdge('e3', 'p', 'b')],
      { maxConcurrency: 1 },
    )

    await run(flow, { handlers: [triggerHandler(), ...slow] })

    expect(order).toEqual([
      'state.set:enter',
      'state.set:exit',
      'ui.toast:enter',
      'ui.toast:exit',
    ])
  })

  it('结束节点终止整张图，包括另一条并行分支', async () => {
    const flow = makeFlow(
      [
        makeTrigger(),
        makeNode('p', 'flow.parallel'),
        makeNode('a', 'flow.end'),
        makeNode('b', 'state.set'),
      ],
      [makeEdge('e1', 't', 'p'), makeEdge('e2', 'p', 'a'), makeEdge('e3', 'p', 'b')],
      { maxConcurrency: 1 },
    )

    const { result } = await run(flow, {
      handlers: [triggerHandler(), ...spyHandler(['state.set'])],
    })

    expect(result.status).toBe('stopped')
    expect(executed).toEqual(['trigger'])
  })

  it('节点条件为假时跳过并继续后续节点', async () => {
    const flow = makeFlow(
      [
        makeTrigger(),
        { ...makeNode('a', 'state.set'), condition: createExpression('{{ skip }}') },
        makeNode('b', 'ui.toast'),
      ],
      [makeEdge('e1', 't', 'a'), makeEdge('e2', 'a', 'b')],
    )

    const { result, steps } = await run(flow, {
      handlers: [triggerHandler(), ...spyHandler(['state.set', 'ui.toast'])],
      createScope: () => ({ skip: false }),
    })

    expect(result.status).toBe('completed')
    expect(steps.find((s) => s.actionId === 'a')?.outcome).toBe('skipped')
    expect(executed).toEqual(['trigger', 'ui.toast'])
  })

  it('失败默认中断，onError 为 continue 时继续走图', async () => {
    const boom: ActionHandler = {
      type: 'state.set',
      async execute() {
        throw new Error('下游超时')
      },
    }

    const trigger = makeTrigger()
    const stepA = makeNode('a', 'state.set')
    const stepB = makeNode('b', 'ui.toast')
    const edges = [makeEdge('e1', 't', 'a'), makeEdge('e2', 'a', 'b')]
    const handlers = [triggerHandler(), boom, ...spyHandler(['ui.toast'])]

    const stopped = await run(makeFlow([trigger, stepA, stepB], edges), { handlers })
    expect(stopped.result.status).toBe('failed')
    expect(executed).toEqual(['trigger'])

    const tolerantFlow = makeFlow([trigger, { ...stepA, onError: 'continue' }, stepB], edges)
    const tolerant = await run(tolerantFlow, { handlers })

    expect(tolerant.result.status).toBe('completed')
    expect(tolerant.steps.find((s) => s.actionId === 'a')?.outcome).toBe('failed')
    expect(executed).toEqual(['trigger', 'ui.toast'])
  })

  it('未注册的动作类型按失败处理并给出类型名', async () => {
    const flow = makeFlow(
      [makeTrigger(), makeNode('x', 'vendor.unknown')],
      [makeEdge('e1', 't', 'x')],
    )

    const { result } = await run(flow, { handlers: [triggerHandler()] })

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.message).toContain('vendor.unknown')
    }
  })

  it('分支表达式没填时该节点失败，而不是随机走一侧', async () => {
    const flow = makeFlow(
      [
        makeTrigger(),
        makeNode('c', 'flow.condition', { expression: 'ok > 1' }),
        makeNode('y', 'state.set'),
      ],
      [makeEdge('e1', 't', 'c'), makeEdge('e2', 'c', 'y', 'true')],
    )

    const { result, steps } = await run(flow, {
      handlers: [triggerHandler(), ...spyHandler(['state.set'])],
    })

    expect(result.status).toBe('failed')
    expect(steps.find((s) => s.actionId === 'c')?.message).toContain('分支条件')
  })

  it('超出步数上限时中止并报告原因', async () => {
    // 一条串行长链，上限 3：触发 + 2 个节点后预算耗尽
    const nodes = [
      makeTrigger(),
      makeNode('a', 'state.set'),
      makeNode('b', 'state.set'),
      makeNode('c', 'state.set'),
    ]
    const edges = [makeEdge('e1', 't', 'a'), makeEdge('e2', 'a', 'b'), makeEdge('e3', 'b', 'c')]

    const { result } = await run(makeFlow(nodes, edges), {
      handlers: [triggerHandler(), ...spyHandler(['state.set'])],
      stepLimit: 3,
    })

    expect(result).toEqual({ status: 'aborted', steps: 3, reason: 'step-limit' })
  })

  it('超出流程超时后中止', async () => {
    const slow: ActionHandler = {
      type: 'state.set',
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 30))
      },
    }

    const flow = makeFlow(
      [makeTrigger(), makeNode('a', 'state.set'), makeNode('b', 'ui.toast')],
      [makeEdge('e1', 't', 'a'), makeEdge('e2', 'a', 'b')],
      { timeoutSeconds: 0.01 },
    )

    const { result } = await run(flow, {
      handlers: [triggerHandler(), slow, ...spyHandler(['ui.toast'])],
    })

    expect(result).toEqual({ status: 'aborted', steps: 2, reason: 'timeout' })
  })

  it('没有触发节点时直接失败，不产出空记录', async () => {
    const flow = makeFlow([makeNode('a', 'state.set')], [])

    const { result, steps } = await run(flow, { handlers: [...spyHandler(['state.set'])] })

    expect(result.status).toBe('failed')
    expect(steps).toHaveLength(0)
  })

  it('指向不存在节点的边被忽略，不影响其余推进', async () => {
    const flow = makeFlow(
      [makeTrigger(), makeNode('a', 'state.set')],
      [makeEdge('e1', 't', 'a'), makeEdge('e2', 'a', 'ghost')],
    )

    const { result } = await run(flow, {
      handlers: [triggerHandler(), ...spyHandler(['state.set'])],
    })

    expect(result.status).toBe('completed')
  })
})
