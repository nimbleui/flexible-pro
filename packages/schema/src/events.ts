/**
 * 事件（Event）架构定义
 * 本文件定义了组件事件系统的核心概念，涵盖：
 * 1. 事件参数（EventParameter）—— 事件触发时携带的数据字段
 * 2. 事件定义（EventDefinition）—— 组件可触发的事件声明
 * 3. 事件处理器（EventHandlerDef）—— 绑定到节点上的具体事件处理动作
 * 4. 事件链（EventChainStep / EventChain）—— 多个处理器按序/分支执行
 * 5. 流式事件（FlowBackedEvent）—— 通过 Flow 配置生成的事件处理链
 */

import type { ExpressionString } from './expression'

/**
 * 事件参数定义接口
 * 描述事件触发时携带的某个参数的名称、类型和说明。
 * 用于在编辑器中为事件处理提供参数提示和类型校验。
 */
export interface EventParameter {
  /** 参数名称 */
  name: string
  /** 参数的数据类型（如 'string', 'number', 'MouseEvent' 等） */
  type: string
  /** 参数的描述说明（可选） */
  description?: string
}

/**
 * 事件定义接口
 * 声明一个组件可以触发的某个事件，包括事件名称、显示标题、
 * 携带的参数列表和描述信息。用于在编辑器中配置事件绑定时展示。
 */
export interface EventDefinition {
  /** 事件名称标识，如 'click'、'change' */
  name: string
  /** 事件在编辑器中的显示标题，如 '点击事件' */
  title: string
  /** 事件触发时携带的参数列表（可选） */
  parameters?: EventParameter[]
  /** 事件的用途描述（可选） */
  description?: string
}

/**
 * 事件链步骤接口
 * 事件链中的一个执行步骤，描述了一个原子操作。
 * 多个步骤按照链式结构组织，支持顺序执行、条件分支和跳转。
 *
 * 事件链步骤通过 `next` 和 `branches` 字段定义执行流转：
 * - 当 `next` 为单个字符串时，执行完当前步骤后跳转到指定步骤
 * - 当 `next` 为数组时，并行执行所有指定的下一步骤
 * - 当 `branches` 存在时，根据条件表达式的结果决定跳转方向
 * - 当 `next` 和 `branches` 均未指定时，按数组顺序执行下一个步骤
 */
export interface EventChainStep {
  /** 步骤唯一标识（在链内唯一），用于后继步骤引用 */
  id: string
  /** 动作类型标识，如 'navigate'、'setVariable'、'callApi'、'showToast' 等 */
  action: string
  /** 动作的配置参数，不同类型动作有不同的配置结构 */
  config: Record<string, unknown>
  /** 步骤显示名称（可选），用于编辑器中标识该步骤 */
  name?: string
  /**
   * 步骤执行的条件表达式（可选）
   * 只有当表达式求值为真时，该步骤才会执行。
   * 如果步骤被跳过，其后续链也会被跳过。
   */
  condition?: ExpressionString
  /**
   * 后继步骤 ID 或 ID 列表（可选）
   * - 字符串：执行完当前步骤后，跳转到该 ID 对应的步骤
   * - 字符串数组：执行完当前步骤后，并行触发所有指定的步骤
   * - 未指定：默认按 steps 数组中的下一个步骤继续执行
   */
  next?: string | string[]
  /**
   * 条件分支目标（可选）
   * 根据 condition 表达式的结果决定跳转方向。
   * 当 condition 求值为 true 时跳转到 true 分支，
   * 为 false 时可选择跳转到 false 分支。
   * 优先级高于 `next` 字段。
   */
  branches?: {
    /** 条件为真时执行的步骤 ID */
    true: string
    /** 条件为假时执行的步骤 ID（可选） */
    false?: string
  }
  /**
   * 是否异步执行该步骤（可选）
   * 为 true 时，引擎不会等待该步骤完成即继续执行下一个步骤。
   * 默认为 false（同步等待）。
   */
  async?: boolean
}

/**
 * 事件链定义接口
 * 描述一个完整的事件处理链，由一组步骤及其执行模式组成。
 * 事件链可以内联定义（steps），也可以引用外部 Flow（flowId）。
 *
 * 当同时指定 steps 和 flowId 时，steps 优先（内联定义覆盖外部引用）。
 */
export interface EventChain {
  /**
   * 事件链中包含的步骤列表
   * 当 flowId 存在且 steps 为空时，步骤由 Flow 定义动态生成。
   */
  steps: EventChainStep[]
  /**
   * 链的执行模式：
   * - 'sequential'：按顺序依次执行步骤（默认）
   * - 'parallel'：所有步骤并行执行
   */
  mode?: 'sequential' | 'parallel'
  /**
   * 错误处理策略（可选）：
   * - 'stop'：出现错误时停止整个链（默认）
   * - 'continue'：即使某个步骤出错也继续执行后续步骤
   * - 'rollback'：出现错误时回滚已执行的步骤
   */
  onError?: 'stop' | 'continue' | 'rollback'
  /**
   * 链执行超时时间（毫秒，可选）
   * 超出此时间未完成则中止执行。
   */
  timeout?: number
}

/**
 * 事件处理器定义（可辨识联合类型）
 *
 * 描述绑定到某个节点上的一个具体事件处理动作。
 * 通过 `kind` 字段区分为三种互斥的处理模式：
 *
 * 1. **ActionHandlerDef**（kind: 'action'）：单步动作模式，直接通过 action + config 定义处理动作
 * 2. **ChainHandlerDef**（kind: 'chain'）：事件链模式，通过 chain 定义多步骤处理流程
 * 3. **FlowHandlerDef**（kind: 'flow'）：流式事件模式，通过 flow 引用一个 Flow 定义
 *
 * 运行时可通过 `handler.kind` 或 `isActionHandler` / `isChainHandler` / `isFlowHandler`
 * 类型守卫进行类型收窄。
 */
export type EventHandlerDef = ActionHandlerDef | ChainHandlerDef | FlowHandlerDef

/**
 * 单步动作处理器
 * 直接通过 action + config 定义单个处理动作。
 * 这是最常见的事件处理形式，适用于简单的单步操作。
 */
export interface ActionHandlerDef {
  /** 类型标识，固定为 'action'，用于可辨识联合类型收窄 */
  kind: 'action'
  /** 动作类型标识，如 'navigate'、'setVariable'、'callApi' 等 */
  action: string
  /** 动作的配置参数，不同类型动作有不同的配置结构 */
  config: Record<string, unknown>
  /** 处理器名称（可选），用于在编辑器中标识 */
  name?: string
  /**
   * 处理条件表达式（可选）
   * 只有当表达式求值为真时，事件处理才会执行。
   */
  condition?: ExpressionString
}

/**
 * 事件链处理器
 * 通过 chain 字段定义多步骤的链式处理流程。
 * 支持条件分支、并行执行和错误处理等复杂流程控制。
 */
export interface ChainHandlerDef {
  /** 类型标识，固定为 'chain'，用于可辨识联合类型收窄 */
  kind: 'chain'
  /** 事件链配置，定义多步骤处理流程 */
  chain: EventChain
  /** 处理器名称（可选），用于在编辑器中标识 */
  name?: string
  /**
   * 处理条件表达式（可选）
   * 只有当表达式求值为真时，事件链才会执行。
   */
  condition?: ExpressionString
}

/**
 * 流式事件处理器
 * 通过 flow 字段引用一个 Flow 定义作为处理逻辑。
 * 适用于复杂的多步骤事件处理，可通过可视化 Flow 编辑器设计。
 * Flow 可以在不同组件/事件之间复用。
 */
export interface FlowHandlerDef {
  /** 类型标识，固定为 'flow'，用于可辨识联合类型收窄 */
  kind: 'flow'
  /** 关联的 Flow 定义 ID */
  flow: string
  /**
   * Flow 输入映射（可选）
   * 定义如何将事件参数映射到 Flow 执行上下文的初始数据。
   *
   * 示例：
   * ```typescript
   * flowInputMapping: {
   *   userId: "{{ event.payload.id }}",
   *   userName: "{{ event.payload.name }}",
   * }
   * ```
   */
  flowInputMapping?: Record<string, string>
  /** 处理器名称（可选），用于在编辑器中标识 */
  name?: string
  /**
   * 处理条件表达式（可选）
   * 只有当表达式求值为真时，Flow 才会执行。
   */
  condition?: ExpressionString
}
