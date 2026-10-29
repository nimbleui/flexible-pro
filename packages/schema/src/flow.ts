/**
 * 流程图（Flow）架构定义
 * ---
 * 本文件定义「可视化流程图」的数据模型，与 FlowEditor（拖拽式流程编辑器）
 * 产出的 节点 + 连线 图一一对应，供 FlowRunner 引擎执行。
 *
 * 一个 Flow 由若干节点（FlowNodeDef）和连线（FlowEdgeDef）组成，节点分五类：
 *  - start     流程入口（唯一起点）
 *  - event     事件/触发点（透传，可携带事件名）
 *  - condition 条件判定（对表达式求值，按结果选择分支连线）
 *  - action    执行一个已注册动作（action + config）
 *  - end       流程终点（可选地产出输出）
 *
 * 与 EventChain 的区别：EventChain 用「步骤数组 + next/branches」描述执行流；
 * Flow 用「节点 + 连线」的图结构描述，天然适配可视化编辑器的拖拽连线交互。
 */

import type { ExpressionString } from './expression'

/** 流程节点类型 */
export type FlowNodeKind = 'start' | 'event' | 'condition' | 'action' | 'end'

/**
 * 流程节点定义
 * 不同 kind 使用不同字段：
 *  - action：需要 action（动作名）+ config（动作配置，支持表达式）
 *  - condition：需要 condition（判定表达式）
 *  - event：可选 event（触发的事件名，仅用于标识）
 *  - start / end：无需额外字段
 */
export interface FlowNodeDef {
  /** 节点唯一标识（在 Flow 内唯一） */
  id: string
  /** 节点类型 */
  kind: FlowNodeKind
  /** 节点显示名称（可选） */
  name?: string
  /** action 节点：引用的动作名（对应 ActionRegistry 中的动作） */
  action?: string
  /** action 节点：动作配置参数，字段值支持 `{{ }}` 表达式 */
  config?: Record<string, unknown>
  /** condition 节点：判定表达式，求值为真/假决定走哪条分支连线 */
  condition?: ExpressionString | string
  /** event 节点：触发的事件名（仅用于标识，可选） */
  event?: string
  /**
   * 将本节点执行结果写入 Flow 上下文的变量名（可选）。
   * 写入后，后续节点的表达式可通过该变量名引用此结果。
   */
  assignTo?: string
}

/**
 * 流程连线定义
 * 描述从 source 节点到 target 节点的有向连接。
 * 对于 condition 源节点，可通过 `when` 或 `condition` 指定该连线代表的分支。
 */
export interface FlowEdgeDef {
  /** 连线唯一标识 */
  id: string
  /** 起始节点 id */
  source: string
  /** 目标节点 id */
  target: string
  /** 连线显示名称（可选），也可用作分支识别（如 'true'/'false'） */
  label?: string
  /**
   * condition 分支匹配（可选）：
   * 当源节点为 condition 且其判定结果与 `when` 一致时，走此连线。
   */
  when?: 'true' | 'false'
  /**
   * 连线自身的条件表达式（可选，优先级最高）。
   * 求值为真时该连线可被选择；用于比 `when` 更细的分支控制。
   */
  condition?: ExpressionString | string
}

/**
 * 流程定义
 * 一张完整的可视化流程图，由节点与连线组成，可被 FlowRunner 引擎执行。
 */
export interface FlowDefinition {
  /** Flow 唯一标识，供 FlowEventBinding.flowId 引用 */
  id: string
  /** Flow 显示名称（可选） */
  name?: string
  /** 流程节点列表 */
  nodes: FlowNodeDef[]
  /** 流程连线列表 */
  edges: FlowEdgeDef[]
  /**
   * 输出映射（可选）
   * Flow 执行结束时基于 Flow 上下文求值并返回的数据。
   * 键为输出字段名，值为表达式（可引用 input、各节点结果及 assignTo 变量）。
   */
  output?: Record<string, unknown>
}
