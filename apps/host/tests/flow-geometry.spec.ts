import { describe, expect, it } from 'vitest'
import type { FlowDefinition, FlowEdge, FlowNode, Rect } from '@lc/schema'
import { FLOW_TRIGGER, createExpression } from '@lc/schema'
import { layoutFlowEdges } from '../src/components/flow/utils/edge-path'
import { projectToMinimap } from '../src/components/flow/utils/minimap'
import { flowNodeRect, flowNodeSize } from '../src/components/flow/constants/node-tone'

function makeNode(
  id: string,
  type: string,
  x: number,
  y: number,
  config: Record<string, unknown> = {},
): FlowNode {
  return { id, type, name: id, position: { x, y }, config }
}

function makeFlow(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): FlowDefinition {
  return {
    id: 'flow-1',
    name: '测试',
    status: 'draft',
    version: '1.0.0',
    updatedAt: '2026-11-03T00:00:00.000Z',
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    edges: Object.fromEntries(edges.map((edge) => [edge.id, edge])),
    settings: { timeoutSeconds: 60, maxConcurrency: 4 },
  }
}

function rectsOf(flow: FlowDefinition): Map<string, Rect> {
  return new Map(Object.values(flow.nodes).map((node) => [node.id, flowNodeRect(node)]))
}

describe('连线路径', () => {
  it('同列上下两个节点之间是一条直线', () => {
    const a = makeNode('a', 'state.set', 100, 0)
    const b = makeNode('b', 'state.set', 100, 200)
    const flow = makeFlow([a, b], [{ id: 'e1', source: 'a', target: 'b' }])

    const route = layoutFlowEdges(flow, rectsOf(flow)).get('e1')
    expect(route?.points).toHaveLength(2)
    expect(route?.d).toBe('M204 66 L204 200')
  })

  it('错列节点走三段正交折线，水平段落在两点中间高度', () => {
    const a = makeNode('a', 'state.set', 0, 0)
    const b = makeNode('b', 'state.set', 300, 200)
    const flow = makeFlow([a, b], [{ id: 'e1', source: 'a', target: 'b' }])

    const route = layoutFlowEdges(flow, rectsOf(flow)).get('e1')
    expect(route?.points.map((point) => point.y)).toEqual([66, 133, 133, 200])
    expect(route?.labelAt).toEqual({ x: 104, y: 133 })
  })

  it('条件节点的是分支从菱形左顶点出发，否分支从右顶点出发', () => {
    const trigger = makeNode('t', FLOW_TRIGGER, 0, 0, {
      sourceNodeId: 'page',
      eventName: 'click',
    })
    const condition = makeNode('c', 'flow.condition', 0, 200, {
      expression: createExpression('{{ ok }}'),
    })
    const yes = makeNode('y', 'state.set', -300, 400)
    const no = makeNode('n', 'state.set', 400, 400)
    const flow = makeFlow(
      [trigger, condition, yes, no],
      [
        { id: 'e1', source: 't', target: 'c' },
        { id: 'e2', source: 'c', target: 'y', branch: 'true' },
        { id: 'e3', source: 'c', target: 'n', branch: 'false' },
      ],
    )

    const routes = layoutFlowEdges(flow, rectsOf(flow))
    const diamond = flowNodeSize(condition)

    // 左顶点 x = rect.x，右顶点 x = rect.x + width，纵高都是菱形中线
    expect(routes.get('e2')?.points[0]).toEqual({ x: 0, y: 200 + diamond.height / 2 })
    expect(routes.get('e3')?.points[0]).toEqual({
      x: diamond.width,
      y: 200 + diamond.height / 2,
    })
  })

  it('同一源节点的多条出边按边 id 分配锚点，顺序稳定', () => {
    const a = makeNode('a', 'flow.parallel', 0, 0)
    const b = makeNode('b', 'state.set', -200, 200)
    const c = makeNode('c', 'state.set', 200, 200)
    const flow = makeFlow(
      [a, b, c],
      [
        { id: 'e2', source: 'a', target: 'c' },
        { id: 'e1', source: 'a', target: 'b' },
      ],
    )

    const routes = layoutFlowEdges(flow, rectsOf(flow))
    expect(routes.get('e1')!.points[0].x).toBeLessThan(routes.get('e2')!.points[0].x)
  })

  it('端点缺失的边不产出路径', () => {
    const a = makeNode('a', 'state.set', 0, 0)
    const flow = makeFlow([a], [{ id: 'e1', source: 'a', target: 'ghost' }])

    expect(layoutFlowEdges(flow, rectsOf(flow)).size).toBe(0)
  })

  it('逆向连线仍然给出可渲染的折线而不是抛错', () => {
    const a = makeNode('a', 'state.set', 0, 200)
    const b = makeNode('b', 'state.set', 300, 0)
    const flow = makeFlow([a, b], [{ id: 'e1', source: 'a', target: 'b' }])

    const route = layoutFlowEdges(flow, rectsOf(flow)).get('e1')
    expect(route?.points).toHaveLength(4)
    expect(route!.points[1].y).toBeGreaterThan(a.position.y + flowNodeSize(a).height)
  })
})

describe('小地图投影', () => {
  const box = { width: 188, height: 128 }

  it('正反向换算互逆，点击小地图能回到原世界坐标', () => {
    const bounds: Rect = { x: -120, y: 40, width: 900, height: 620 }
    const projection = projectToMinimap(bounds, box, 8)
    const point = { x: 63.5, y: 41.25 }

    const world = projection.invert(point)

    expect(projection.project({ ...world, width: 0, height: 0 })).toEqual({
      x: point.x,
      y: point.y,
      width: 0,
      height: 0,
    })
  })

  it('整张图落在盒子内且四周留白不小于 padding', () => {
    const bounds: Rect = { x: 0, y: 0, width: 1000, height: 100 }
    const projection = projectToMinimap(bounds, box, 8)
    const drawn = projection.project(bounds)

    expect(drawn.x).toBeGreaterThanOrEqual(8)
    expect(drawn.y).toBeGreaterThanOrEqual(8)
    expect(drawn.x + drawn.width).toBeLessThanOrEqual(box.width - 8 + 0.001)
    expect(drawn.height).toBeLessThanOrEqual(box.height - 16 + 0.001)
  })

  it('图比盒子小时按实际尺寸居中，不会把单个节点拉满', () => {
    const bounds: Rect = { x: 0, y: 0, width: 100, height: 60 }
    const projection = projectToMinimap(bounds, box, 8)
    const drawn = projection.project(bounds)

    expect(drawn.width).toBeLessThanOrEqual(100)
    expect(drawn.x).toBeGreaterThan(8)
  })

  it('零尺寸输入退回兜底缩放而不是产出 Infinity', () => {
    const projection = projectToMinimap({ x: 5, y: 5, width: 0, height: 0 }, box, 8)
    const drawn = projection.project({ x: 5, y: 5, width: 0, height: 0 })

    expect(Number.isFinite(projection.scale)).toBe(true)
    expect(projection.invert(drawn)).toEqual({ x: 5, y: 5 })
  })
})
