import type { Point } from '@lc/contracts'
import type { FlowDefinition, FlowEdge, FlowNode, Rect } from '@lc/schema'
import { FLOW_BRANCH_FALSE, FLOW_BRANCH_TYPES, FLOW_CONDITION } from '@lc/schema'
import { flowNodeSize } from '../constants/node-tone'

/**
 * 连线的锚点与正交路径。
 *
 * 全部是纯几何：输入是文档里的矩形与边，输出是 SVG 路径字符串。画布组件只负责把
 * 结果写进 DOM，因此这套规则能脱离浏览器单测，也能被小地图复用同一条折线。
 */

/** 一条连线的布局结果 */
export interface EdgeRoute {
  /** SVG `path` 的 `d` 属性 */
  d: string
  /** 分支标签（是 / 否）的锚点，落在第一个拐点处 */
  labelAt: Point
  /** 折点序列，含首尾；小地图按它画细线 */
  points: Point[]
}

/**
 * 连线在一次试运行里的走向。
 *
 * `idle` 与 `unreached` 是两件事：前者是「本次运行还没对它作出判断」（执行途中），
 * 后者是「跑完了但这条线没被走过」（分支没选中、或上游失败后停住了）。
 * 合并成一个就会在运行途中把整张图涂成灰的。
 */
export type FlowEdgeRunState = 'idle' | 'traversed' | 'skipped' | 'failed' | 'unreached'

/** 出边在源节点底边散开时的最小间距，避免两条线共用同一个锚点看不出分支 */
const PORT_SPACING = 26

/** 正向连线里水平段所在的高度下限，防止拐点贴着节点边缘 */
const MIN_BEND_OFFSET = 20

/** 逆向（回边）连线先向下让出的距离 */
const FALLBACK_DROP = 24

/** 把折点序列拼成 SVG 路径；`M` + 连续 `L` 足够描述正交折线，不需要曲线 */
function toPathData(points: readonly Point[]): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`)
    .join(' ')
}

/** 路径坐标保留一位小数：缩放 250% 时肉眼看不出差别，但字符串短一半 */
function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** 按序号在一条边上均匀散开锚点，`count` 为 1 时正好落在中点 */
function spread(base: number, index: number, count: number, size: number): number {
  if (count <= 1) return base + size / 2

  const usable = Math.min(size - PORT_SPACING, size)
  const step = usable / (count - 1)

  return base + (size - usable) / 2 + step * index
}

/**
 * 出锚点。
 *
 * 条件节点的两条分支从菱形左右顶点出发，与参考图一致：是 / 否 两个标签正好落在
 * 顶点外侧，作者不需要猜哪条线属于哪个分支。其余节点从底边按序号散开。
 */
function outputAnchor(
  node: FlowNode,
  edge: FlowEdge,
  index: number,
  count: number,
  rect: Rect,
): Point {
  const size = flowNodeSize(node)

  if (node.type === FLOW_CONDITION && edge.branch) {
    const y = rect.y + size.height / 2

    return {
      x: edge.branch === FLOW_BRANCH_FALSE ? rect.x + size.width : rect.x,
      y,
    }
  }

  if (FLOW_BRANCH_TYPES.has(node.type) && edge.branch) {
    // 多分支的出边同样从底边散开，但按 branch 字典序排，保证同一份文档每次渲染一致
    return { x: spread(rect.x, index, count, size.width), y: rect.y + size.height }
  }

  return { x: spread(rect.x, index, count, size.width), y: rect.y + size.height }
}

/** 入锚点：一律在顶边按序号散开 */
function inputAnchor(rect: Rect, index: number, count: number): Point {
  return { x: spread(rect.x, index, count, rect.width), y: rect.y }
}

/**
 * 在两个锚点之间生成正交折线。
 *
 * 正向（目标在下方）走「下 → 横 → 下」：水平段放在两点的中间高度，跨越多层节点时
 * 也不会穿过任何节点框。横向偏移小于 1 时退化成直线，省掉两个拐点。
 *
 * 逆向或同层（校验会把它判成环并阻断发布）仍给出可渲染的路径而不是抛错：设计期
 * 允许存在一条还没连对的线，画不出来比画得丑更难排查。
 */
function routePoints(from: Point, to: Point): Point[] {
  if (Math.abs(from.x - to.x) < 1) return [from, to]

  if (to.y - from.y >= MIN_BEND_OFFSET * 2) {
    const bendY = from.y + (to.y - from.y) / 2

    return [from, { x: from.x, y: bendY }, { x: to.x, y: bendY }, to]
  }

  const dropY = from.y + FALLBACK_DROP

  return [from, { x: from.x, y: dropY }, { x: to.x, y: dropY }, to]
}

/**
 * 布局一张图的全部连线。
 *
 * 两端任一节点缺失的边不出现在结果里——由 `validateFlow` 报 error，这里只保证
 * 剩下的线仍然画得出来。同一源节点的出边按 id 排序后分配锚点，同一目标的入边同理，
 * 因此 Object.keys 的顺序变化不会让线条在两次渲染之间跳动。
 *
 * @param flow 待布局的流程图
 * @param rects 节点 id → 世界矩形，通常由 `flowNodeRect` 逐节点算好
 * @returns 连线 id → 路径结果
 */
export function layoutFlowEdges(
  flow: FlowDefinition,
  rects: ReadonlyMap<string, Rect>,
): Map<string, EdgeRoute> {
  const outGroups = groupEdges(flow, (edge) => edge.source)
  const inGroups = groupEdges(flow, (edge) => edge.target)
  const routes = new Map<string, EdgeRoute>()

  for (const edge of Object.values(flow.edges)) {
    const sourceRect = rects.get(edge.source)
    const targetRect = rects.get(edge.target)
    if (!sourceRect || !targetRect) continue

    const source = flow.nodes[edge.source]
    const target = flow.nodes[edge.target]
    if (!source || !target) continue

    const outIndex = outGroups.get(edge.source)?.indexOf(edge) ?? 0
    const outCount = outGroups.get(edge.source)?.length ?? 1
    const inIndex = inGroups.get(edge.target)?.indexOf(edge) ?? 0
    const inCount = inGroups.get(edge.target)?.length ?? 1

    const from = outputAnchor(source, edge, outIndex, outCount, sourceRect)
    const to = inputAnchor(targetRect, inIndex, inCount)
    const points = routePoints(from, to)

    routes.set(edge.id, {
      d: toPathData(points),
      labelAt:
        points.length > 2 ? points[1] : { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      points,
    })
  }

  return routes
}

/** 按源或目标把边分组，组内按 id 排序 */
function groupEdges(
  flow: FlowDefinition,
  keyOf: (edge: FlowEdge) => string,
): Map<string, FlowEdge[]> {
  const groups = new Map<string, FlowEdge[]>()

  for (const edge of Object.values(flow.edges)) {
    const key = keyOf(edge)
    const list = groups.get(key)
    if (list) list.push(edge)
    else groups.set(key, [edge])
  }

  for (const list of groups.values()) list.sort((a, b) => a.id.localeCompare(b.id))

  return groups
}
