import { describe, expect, it } from 'vitest'
import type { FlowDefinition, FlowEdge, FlowNode, FlowSettings } from '../src/flow'
import {
  DEFAULT_FLOW_SETTINGS,
  FLOW_TRIGGER,
  createFlowNode,
  findFlowNodeType,
  flowBindingOf,
  flowNodeFields,
  readFlowTriggerBinding,
} from '../src/flow'
import { createExpression } from '../src/expression'
import {
  buildFlowAdjacency,
  collectFlowReachable,
  flowOutEdges,
  validateFlow,
} from '../src/flow-graph'

function makeTrigger(id: string, sourceNodeId = 'page', eventName = 'pageLoad'): FlowNode {
  return {
    id,
    type: FLOW_TRIGGER,
    name: '开始',
    position: { x: 0, y: 0 },
    config: { kind: 'pageEvent', sourceNodeId, eventName },
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
  settings?: Partial<FlowSettings>,
): FlowDefinition {
  return {
    id: 'flow-1',
    name: '订单审批流程',
    status: 'draft',
    version: '1.0.0',
    updatedAt: '2026-11-03T00:00:00.000Z',
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    edges: Object.fromEntries(edges.map((edge) => [edge.id, edge])),
    settings: { ...DEFAULT_FLOW_SETTINGS, ...settings },
  }
}

describe('流程图协议', () => {
  it('按节点库条目生成节点时预置触发来源与必填空值', () => {
    const node = createFlowNode('trigger.component', 'n1', { x: 12, y: 30 })

    expect(node.type).toBe(FLOW_TRIGGER)
    expect(node.config.kind).toBe('componentEvent')
    // 必填字段预置空串，面板才能立刻渲染出可填的输入框而不是判断「键不存在」
    expect(node.config.sourceNodeId).toBe('')
    expect(node.config.eventName).toBe('')
    expect(node.position).toEqual({ x: 12, y: 30 })
  })

  it('页面事件条目自带 page 哨兵值，json 字段不预置空串', () => {
    const node = createFlowNode('trigger.page', 'n1', { x: 0, y: 0 })
    expect(node.config.sourceNodeId).toBe('page')

    const merge = createFlowNode('logic.merge', 'n2', { x: 0, y: 0 })
    expect('sources' in merge.config).toBe(false)
    expect(merge.config.assignTo).toBe('')
  })

  it('未知条目 key 抛错而不是生成空节点', () => {
    expect(() => createFlowNode('nope', 'n1', { x: 0, y: 0 })).toThrow(/节点库中不存在条目/)
  })

  it('字段声明优先取图专属，其次回落到内置动作', () => {
    expect(flowNodeFields(FLOW_TRIGGER).map((field) => field.key)).toEqual([
      'sourceNodeId',
      'eventName',
    ])
    // state.set 在链与图里是同一件事，字段只声明一份
    expect(flowNodeFields('state.set').map((field) => field.key)).toEqual(['key', 'value'])
    expect(flowNodeFields('flow.parallel')).toEqual([])
    expect(flowNodeFields('vendor.custom')).toEqual([])
  })

  it('按类型能取回展示元数据', () => {
    expect(findFlowNodeType('flow.subflow')?.title).toBe('子流程')
    expect(findFlowNodeType('missing.type')).toBeUndefined()
  })

  it('读取触发绑定，配置不完整时返回 null', () => {
    expect(readFlowTriggerBinding(makeTrigger('t', 'button', 'click'))).toEqual({
      kind: 'pageEvent',
      sourceNodeId: 'button',
      eventName: 'click',
    })

    const broken = makeTrigger('t')
    broken.config.eventName = ''
    expect(readFlowTriggerBinding(broken)).toBeNull()

    expect(readFlowTriggerBinding(makeNode('a', 'state.set'))).toBeNull()
  })

  it('取整张图的绑定；没有触发节点时返回 undefined', () => {
    const trigger = makeTrigger('t', 'button', 'submit')
    expect(flowBindingOf(makeFlow([trigger], []))).toEqual({
      kind: 'pageEvent',
      sourceNodeId: 'button',
      eventName: 'submit',
    })
    expect(flowBindingOf(makeFlow([makeNode('a', 'state.set')], []))).toBeUndefined()
  })
})

describe('出边邻接表与可达性', () => {
  it('忽略悬空边并按边 id 稳定排序', () => {
    const trigger = makeTrigger('t')
    const a = makeNode('a', 'state.set')
    const b = makeNode('b', 'ui.toast')
    const flow = makeFlow(
      [trigger, a, b],
      // z 排在 a 之后写入，但 id 字典序靠后，遍历顺序必须是 a → z
      [makeEdge('z', 't', 'b'), makeEdge('a', 't', 'a'), makeEdge('bad', 't', 'ghost')],
    )

    const adjacency = buildFlowAdjacency(flow)
    expect(flowOutEdges(adjacency, 't').map((edge) => edge.id)).toEqual(['a', 'z'])
    expect(adjacency.has('ghost')).toBe(false)
  })

  it('可达集覆盖两条分支，叶子节点自身也算可达', () => {
    const trigger = makeTrigger('t')
    const condition = makeNode('c', 'flow.condition')
    const yes = makeNode('y', 'state.set')
    const no = makeNode('n', 'state.set')
    const orphan = makeNode('o', 'state.set')
    const flow = makeFlow(
      [trigger, condition, yes, no, orphan],
      [
        makeEdge('e1', 't', 'c'),
        makeEdge('e2', 'c', 'y', 'true'),
        makeEdge('e3', 'c', 'n', 'false'),
      ],
    )

    expect([...collectFlowReachable(flow, 't')].sort()).toEqual(['c', 'n', 't', 'y'])
    expect(collectFlowReachable(flow, 'o')).toEqual(new Set(['o']))
    expect(collectFlowReachable(flow, 'ghost').size).toBe(0)
  })

  it('菱形汇聚只把 join 节点算一次，不会因两条入边重复展开', () => {
    const trigger = makeTrigger('t')
    const left = makeNode('l', 'state.set')
    const right = makeNode('r', 'state.set')
    const join = makeNode('j', 'ui.toast')
    const flow = makeFlow(
      [trigger, left, right, join],
      [
        makeEdge('e1', 't', 'l'),
        makeEdge('e2', 't', 'r'),
        makeEdge('e3', 'l', 'j'),
        makeEdge('e4', 'r', 'j'),
      ],
    )

    expect(collectFlowReachable(flow, 't')).toEqual(new Set(['t', 'l', 'r', 'j']))
  })
})

describe('流程图校验', () => {
  const validFlow = () => {
    const trigger = makeTrigger('t')
    const condition = makeNode('c', 'flow.condition', {
      expression: createExpression('{{ x > 0 }}'),
    })
    const yes = makeNode('y', 'state.set', { key: 'result', value: 'approved' })
    const no = makeNode('n', 'state.set', { key: 'result', value: 'rejected' })
    const end = makeNode('e', 'flow.end')

    return makeFlow(
      [trigger, condition, yes, no, end],
      [
        makeEdge('e1', 't', 'c'),
        makeEdge('e2', 'c', 'y', 'true'),
        makeEdge('e3', 'c', 'n', 'false'),
        makeEdge('e4', 'y', 'e'),
        makeEdge('e5', 'n', 'e'),
      ],
    )
  }

  it('完整图只留下「结束节点无出边」之外的零问题', () => {
    expect(validateFlow(validFlow())).toEqual([])
  })

  it('缺流程名与缺触发节点都是阻断问题', () => {
    const flow = validFlow()
    flow.name = '  '
    delete flow.nodes.t
    flow.edges.e1.source = 'ghost'

    const paths = validateFlow(flow).map((issue) => issue.path)
    expect(paths).toContain('/name')
    expect(paths).toContain('/nodes')
    expect(paths).toContain('/edges/e1/source')
  })

  it('多个触发节点时只保留第一个，其余报错', () => {
    const flow = validFlow()
    const extra = makeTrigger('t2', 'page', 'pageUnload')
    flow.nodes.t2 = extra

    const issues = validateFlow(flow).filter((issue) => issue.path === '/nodes/t2')
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('只允许一个触发节点')
  })

  it('触发绑定不完整时报配置问题', () => {
    const flow = validFlow()
    flow.nodes.t.config.eventName = ''

    expect(validateFlow(flow).map((issue) => issue.path)).toContain('/nodes/t/config')
  })

  it('自环与重复连线各自报错', () => {
    const flow = validFlow()
    flow.edges.loop = makeEdge('loop', 'y', 'y')
    flow.edges.dup = makeEdge('dup', 't', 'c')

    const paths = validateFlow(flow).map((issue) => issue.path)
    expect(paths).toContain('/edges/loop')
    expect(paths).toContain('/edges/dup')
  })
  it('成环时指出环上的节点顺序', () => {
    const flow = validFlow()
    // 让结束节点回指条件节点，构成 c → y → e → c
    flow.edges.back = makeEdge('back', 'e', 'c')

    const cycles = validateFlow(flow).filter((issue) => issue.message.includes('存在环'))
    expect(cycles.length).toBeGreaterThan(0)
    expect(cycles[0].message).toContain('c → y → e → c')
  })

  it('条件节点缺一条分支是 error，普通节点带分支标记是 warning', () => {
    const flow = validFlow()
    delete flow.edges.e3
    // 给非分支节点 y 的出边加上分支标记
    flow.edges.e4.branch = 'true'

    const issues = validateFlow(flow)
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('缺少「否」'))).toBe(
      true,
    )
    expect(issues.some((i) => i.severity === 'warning' && i.path === '/edges/e4/branch')).toBe(
      true,
    )
  })

  it('多分支节点只要有一条带匹配值的出边即可', () => {
    const trigger = makeTrigger('t')
    const sw = makeNode('s', 'flow.switch', { expression: createExpression('{{ status }}') })
    const a = makeNode('a', 'state.set', { key: 'k', value: 'v' })
    const flow = makeFlow(
      [trigger, sw, a],
      [makeEdge('e1', 't', 's'), makeEdge('e2', 's', 'a', 'paid')],
    )

    expect(validateFlow(flow)).toEqual([])
  })

  it('多分支节点没有任何匹配值时报 error', () => {
    const trigger = makeTrigger('t')
    const sw = makeNode('s', 'flow.switch', { expression: createExpression('{{ status }}') })
    const a = makeNode('a', 'state.set', { key: 'k', value: 'v' })
    const flow = makeFlow(
      [trigger, sw, a],
      [makeEdge('e1', 't', 's'), makeEdge('e2', 's', 'a')],
    )

    expect(validateFlow(flow).some((i) => i.message.includes('出边都没有匹配值'))).toBe(true)
  })

  it('必填配置缺失报 error，表达式字段写成裸文本也报 error', () => {
    const flow = validFlow()
    flow.nodes.c.config.expression = 'x > 0'
    flow.nodes.y.config.key = ''

    const issues = validateFlow(flow)
    expect(issues.map((i) => i.path)).toContain('/nodes/y/config/key')
    expect(issues.map((i) => i.path)).toContain('/nodes/c/config/expression')
    expect(issues.find((i) => i.path === '/nodes/c/config/expression')?.message).toContain(
      '恒为真',
    )
  })

  it('补救策略缺节点时报 error', () => {
    const flow = validFlow()
    flow.nodes.y.onError = 'fallback'

    expect(validateFlow(flow).map((i) => i.path)).toContain('/nodes/y/fallbackActionId')

    flow.nodes.y.fallbackActionId = 'ghost'
    expect(validateFlow(flow).map((i) => i.path)).toContain('/nodes/y/fallbackActionId')
  })

  it('孤立节点只报 warning，草稿允许存在', () => {
    const flow = validFlow()
    const orphan = makeNode('o', 'state.set', { key: 'k', value: 'v' })
    flow.nodes.o = orphan

    const issues = validateFlow(flow)
    expect(issues.every((i) => i.severity === 'warning')).toBe(true)
    expect(issues.some((i) => i.message.includes('不可达'))).toBe(true)
  })

  it('节点键与 id 不一致时报 error', () => {
    const flow = validFlow()
    flow.nodes.clone = { ...flow.nodes.y, id: 'y' }

    expect(validateFlow(flow).map((i) => i.path)).toContain('/nodes/clone/id')
  })
})
