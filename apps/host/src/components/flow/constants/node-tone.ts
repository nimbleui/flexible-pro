import type { FlowNode, FlowNodeCategory, Rect } from '@lc/schema'
import {
  FLOW_BRANCH_TYPES,
  FLOW_CONDITION,
  FLOW_END,
  FLOW_NODE_CATALOG,
  FLOW_TRIGGER,
} from '@lc/schema'

/**
 * 节点在画布上的几何与配色。
 *
 * 尺寸**不入文档**：节点只存左上角坐标，宽高由类型推导。写进文档会带来一类
 * 「改了目录宽度但老文档还是旧尺寸」的脏数据，而本轮没有任何节点需要自定义大小。
 */

/** 普通动作节点的宽高 */
const ACTION_NODE_SIZE = { width: 208, height: 66 }

/** 分支节点（菱形）的宽高：要装下标题与副标题，比对角线更扁 */
const BRANCH_NODE_SIZE = { width: 224, height: 108 }

/** 触发与结束节点更紧凑，参考图里它们是胶囊形 */
const TERMINAL_NODE_SIZE = { width: 188, height: 62 }

/** 节点类型 → 分组，从节点库目录反查一次建好 */
const CATEGORY_BY_TYPE = new Map(FLOW_NODE_CATALOG.map((entry) => [entry.type, entry.category]))

/**
 * 分组展示顺序。
 *
 * 显式列一份而不是从目录声明顺序推导：面板分组顺序属于展示决策，
 * 不该被目录里新增条目的插入位置意外改动。
 */
export const FLOW_CATEGORY_ORDER: readonly FlowNodeCategory[] = [
  'trigger',
  'control',
  'logic',
  'data',
  'system',
]

/** 顶部筛选 chips；`all` 表示不按分组过滤，标签比目录分组名短一档以适配窄栏 */
export const FLOW_CATEGORY_FILTERS: readonly {
  value: FlowNodeCategory | 'all'
  label: string
}[] = [
  { value: 'all', label: '全部' },
  { value: 'trigger', label: '触发' },
  { value: 'control', label: '控制' },
  { value: 'logic', label: '逻辑' },
  { value: 'data', label: '数据' },
  { value: 'system', label: '系统' },
]

/**
 * 节点所属分组。
 *
 * 分组不落库，由节点库目录反查：同一类型在链与图里是同一件事，各存一份分组就会出现
 * 「目录改了、老节点还挂在旧分组」。查不到目录条目时按 `logic` 兜底，让插件自定义
 * 类型仍然能在面板里被看见，而不是从画布上消失。
 */
export function flowNodeCategoryOf(node: FlowNode): FlowNodeCategory {
  return CATEGORY_BY_TYPE.get(node.type) ?? 'logic'
}

/**
 * 节点卡片的强调色（CSS 变量名，不是色值）。
 *
 * 走 token 而不是硬编码，是因为画布覆盖层同样按变量名取色；直接写十六进制会让
 * 主题调整只改一半。取值语义与参考图一致：触发与结束是绿色，分支是琥珀色，
 * 并行与通知是亮蓝，其余按分组给主蓝。
 */
export function flowNodeTone(node: FlowNode): string {
  if (node.type === FLOW_TRIGGER || node.type === FLOW_END) return '--lc-success'
  if (FLOW_BRANCH_TYPES.has(node.type)) return '--lc-warning'
  if (node.type === 'flow.parallel') return '--lc-accent-bright'

  return '--lc-accent'
}

/**
 * 取节点宽高。
 *
 * 只读 `type`，所以参数收窄成 `Pick<FlowNode, 'type'>`：从节点库落一个节点前，
 * 面板手里只有目录条目，没有完整节点对象。
 */
export function flowNodeSize(node: Pick<FlowNode, 'type'>): { width: number; height: number } {
  if (FLOW_BRANCH_TYPES.has(node.type)) return BRANCH_NODE_SIZE
  if (node.type === FLOW_TRIGGER || node.type === FLOW_END) return TERMINAL_NODE_SIZE

  return ACTION_NODE_SIZE
}

/** 节点的世界矩形；命中、连线路径与小地图共用同一份推导 */
export function flowNodeRect(node: FlowNode): Rect {
  const size = flowNodeSize(node)

  return { x: node.position.x, y: node.position.y, width: size.width, height: size.height }
}
