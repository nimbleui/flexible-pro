import { describe, expect, it } from 'vitest'
import type { ActionService, EditorContext } from '@lc/contracts'
import type {
  ExpressionScope,
  FlowDefinition,
  FlowEdge,
  FlowNode,
  PageSchema,
} from '@lc/schema'
import {
  DEFAULT_FLOW_SETTINGS,
  FLOW_TRIGGER,
  SCHEMA_VERSION,
  isExpressionString,
} from '@lc/schema'
import actionPlugin from '../src'

/**
 * 求值替身。
 *
 * 与 `runner.spec` / `flow-runner.spec` 同一口径：`{{ name }}` 读作用域，缺变量就抛错。
 * 本文件验的是 `trigger` 的**选路**——哪条连接跑、跑完链要不要接着跑图、绑了草稿图时怎么办；
 * 表达式求值本身由 `service-expression` 的用例覆盖。
 */
function evaluateExpression(raw: string, scope: ExpressionScope): unknown {
  const name = raw.replace(/[{}]/g, '').trim()
  if (!(name in scope)) throw new Error(`作用域里没有变量 "${name}"`)

  return scope[name]
}

/** 触发事件的那个按钮节点 */
const BTN: PageSchema['nodes']['btn'] = { id: 'btn', componentName: 'Button' }

/** 一条只放一个按钮的最小页面 */
function makeSchema(input: Partial<PageSchema> = {}): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'root',
    nodes: { root: { id: 'root', componentName: 'Page', children: ['btn'] }, btn: BTN },
    components: [],
    ...input,
  }
}

function makeFlowNode(id: string): FlowNode {
  return { id, type: 'test.noop', name: id, position: { x: 0, y: 0 }, config: {} }
}

/**
 * 造一张能被事件唤起的流程图：触发节点 → 依次串联 `nodeIds`。
 *
 * 触发节点 config 里只有 `kind`——绑定不在这张图上，而在页面连接的 `flowId` 上。
 */
function makeFlow(
  nodeIds: readonly string[],
  status: FlowDefinition['status'] = 'published',
): FlowDefinition {
  const trigger: FlowNode = {
    id: 't',
    type: FLOW_TRIGGER,
    name: '开始',
    position: { x: 0, y: 0 },
    config: { kind: 'pageEvent' },
  }
  const nodes: FlowNode[] = [trigger, ...nodeIds.map(makeFlowNode)]
  const edges: FlowEdge[] = nodes.slice(1).map((node, index) => ({
    id: `e${index}`,
    source: nodes[index].id,
    target: node.id,
  }))

  return {
    id: 'flow-1',
    name: '测试流程',
    status,
    version: '1.0.0',
    updatedAt: '2026-11-03T00:00:00.000Z',
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    edges: Object.fromEntries(edges.map((edge) => [edge.id, edge])),
    settings: { ...DEFAULT_FLOW_SETTINGS },
  }
}

/** `createService` 的输入 */
interface FakeInput {
  /** 页面文档片段；`connections` / `actions` 决定链侧的行为 */
  schema?: Partial<PageSchema>
  /** 宿主图仓库的内容；不传表示这个宿主没有 `FlowService` */
  flows?: readonly FlowDefinition[]
}

/**
 * 装一个只填 `trigger` 所需片段的 Editor Realm。
 *
 * 返回执行时间线（链的动作 id 与图的节点 id 混在同一条序列里，顺序因此可直接断言）
 * 与 `getPublished` 被问过哪些 id。
 */
function createService(input: FakeInput = {}) {
  /** 执行时间线 */
  const executed: string[] = []
  /** 每次触发向图仓库问过的 id */
  const asked: string[] = []
  const flows = input.flows ?? []
  let provided: ActionService | undefined

  const context = {
    document: {
      model: { id: 'doc-1', schema: makeSchema(input.schema) },
    },
    dataSource: { states: () => [] },
    pageState: { snapshot: () => ({}) },
    expression: {
      compile: (raw: string) => ({
        evaluate: (scope: ExpressionScope) => evaluateExpression(raw, scope),
      }),
      resolveValue: (value: unknown, scope: ExpressionScope) =>
        isExpressionString(value) ? evaluateExpression(value.raw, scope) : value,
    },
    get: () => undefined,
    provide: (name: string, value: unknown) => {
      if (name === 'action') provided = value as ActionService
    },
    effect: <T>(factory: () => T) => factory(),
    flow:
      input.flows === undefined
        ? undefined
        : {
            getPublished: (flowId: string) => {
              asked.push(flowId)
              const flow = flows.find((item) => item.id === flowId)
              return flow?.status === 'published' ? flow : undefined
            },
            list: () => flows,
            onDidChange: () => ({ dispose: () => {} }),
          },
  } as unknown as EditorContext

  actionPlugin.apply(context, undefined)

  if (!provided) throw new Error('service-action 未提供 action 服务')

  /** 链的动作与图的节点用同一类型，两条来源的执行才落在同一条时间线上 */
  provided.register({
    type: 'test.noop',
    async execute({ action }) {
      executed.push(action.id)
    },
  })

  return { service: provided, executed, asked }
}

/** `btn` 的 `click` 上一条启用的两动作连接 */
function makeConnection(enabled: boolean, flowId?: string): PageSchema['connections'] {
  return {
    c1: {
      id: 'c1',
      sourceNodeId: 'btn',
      eventName: 'click',
      actionIds: ['chain-a', 'chain-b'],
      ...(flowId === undefined ? {} : { flowId }),
      enabled,
    },
  }
}

/** 页面上的动作表；两条动作与图节点同为 `test.noop`，好放进同一条时间线 */
const ACTIONS: PageSchema['actions'] = {
  'chain-a': { id: 'chain-a', type: 'test.noop', config: {} },
  'chain-b': { id: 'chain-b', type: 'test.noop', config: {} },
}

/** 默认页面：一条启用连接 + 两个动作，连接绑到 `flow-1` */
const CHAIN_SCHEMA: Partial<PageSchema> = {
  connections: makeConnection(true, 'flow-1'),
  actions: ACTIONS,
}

describe('trigger 的两条执行来源', () => {
  it('同一事件键下的动作链与已发布流程图都执行，链在前', async () => {
    const { service, executed, asked } = createService({
      schema: CHAIN_SCHEMA,
      flows: [makeFlow(['graph-1'])],
    })

    const results = await service.trigger('btn', 'click')

    expect(asked).toEqual(['flow-1'])
    expect(executed).toEqual(['chain-a', 'chain-b', 'graph-1'])
    expect(results.map((result) => result.status)).toEqual(['completed', 'completed'])
  })

  it('连接没绑流程图时只跑链，也不去问图仓库', async () => {
    const { service, executed, asked } = createService({
      schema: { connections: makeConnection(true), actions: ACTIONS },
      flows: [makeFlow(['graph-1'])],
    })

    const results = await service.trigger('btn', 'click')

    expect(asked).toEqual([])
    expect(executed).toEqual(['chain-a', 'chain-b'])
    expect(results).toHaveLength(1)
  })

  it('宿主没装 FlowService 时只跑链，行为与引入流程图之前一致', async () => {
    const { service, executed } = createService({ schema: CHAIN_SCHEMA })

    const results = await service.trigger('btn', 'click')

    expect(executed).toEqual(['chain-a', 'chain-b'])
    expect(results).toHaveLength(1)
  })

  it('停用连接不跑，它绑的图也不跑', async () => {
    const { service, executed, asked } = createService({
      schema: { connections: makeConnection(false, 'flow-1'), actions: ACTIONS },
      flows: [makeFlow(['graph-1'])],
    })

    await service.trigger('btn', 'click')

    expect(executed).toEqual([])
    expect(asked).toEqual([])
  })

  it('绑的是草稿图时不执行，也不留一条失败记录', async () => {
    /**
     * 「没绑图」与「绑了一张还不能跑的图」都不该出现在结果里：调用方按结果条数统计执行，
     * 混进一条 failed 会让用户以为自己的事件跑坏了，而真正的问题只在图还没发布。
     */
    const { service, executed, asked } = createService({
      schema: CHAIN_SCHEMA,
      flows: [makeFlow(['graph-1'], 'draft')],
    })

    const results = await service.trigger('btn', 'click')

    expect(asked).toEqual(['flow-1'])
    expect(executed).toEqual(['chain-a', 'chain-b'])
    expect(results).toHaveLength(1)
  })

  it('绑的图不存在时只跑链，不抛错', async () => {
    const { service, executed } = createService({
      schema: CHAIN_SCHEMA,
      flows: [{ ...makeFlow(['graph-1']), id: 'other-flow' }],
    })

    await service.trigger('btn', 'click')

    expect(executed).toEqual(['chain-a', 'chain-b'])
  })

  it('图缺少触发节点时链仍完成，图以 failed 返回而不是拖垮事件分派', async () => {
    /** 把触发节点摘掉：这张图不可能被任何事件唤起，执行器必须明说而不是「成功跑了 0 步」 */
    const triggerless: FlowDefinition = {
      ...makeFlow(['graph-1']),
      nodes: { 'graph-1': makeFlowNode('graph-1') },
      edges: {},
    }

    const { service, executed } = createService({
      schema: CHAIN_SCHEMA,
      flows: [triggerless],
    })

    const results = await service.trigger('btn', 'click')

    expect(executed).toEqual(['chain-a', 'chain-b'])
    expect(results.map((result) => result.status)).toEqual(['completed', 'failed'])
  })
})
