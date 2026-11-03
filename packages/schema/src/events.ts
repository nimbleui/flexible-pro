/**
 * 事件声明（Event Declaration）
 * ---
 * 本文件只描述「一个组件能触发哪些事件、每个事件带什么参数」，属于**设计态声明**：
 * 物料在 manifest 里登记，事件流面板据此列出候选事件名与参数，表达式编辑器据此补全
 * `event.xxx`。
 *
 * 这里**不含**任何「事件触发后做什么」的模型。「做什么」统一由 `actions.ts` 的
 * 「事件连接 + 动作链」表达（`PageSchema.connections` / `PageSchema.actions`）。
 *
 * 曾经本文件还并存一套 `EventChainStep` / `EventChain` / `EventHandlerDef` 内联事件链，
 * 与动作链构成两个互相竞争的事件模型：同一个节点的事件既可能写在 `NodeSchema.events`
 * 里，也可能写在 `PageSchema.connections` 里，校验无从判断谁生效。那套模型从未有运行时
 * 消费者，已整体删除，事件绑定只保留 `connections` 一条路径。
 */

/**
 * 事件参数定义。
 *
 * 描述事件触发时携带的某个字段，供编辑器补全与类型校验使用。
 * `type` 是给人看的文本标注（如 `'string'`、`'MouseEvent'`），不是运行时类型系统：
 * 真实 payload 由组件 emit 决定，声明与实现不符时以实现为准。
 */
export interface EventParameter {
  /** 参数名；在表达式里以 `event.<name>` 访问 */
  name: string
  /** 参数的数据类型标注，如 `'string'`、`'number'`、`'MouseEvent'` */
  type: string
  /** 参数用途说明（可选），显示在补全详情里 */
  description?: string
}

/**
 * 事件定义。
 *
 * 声明一个组件可以触发的某个事件。物料通过 `MaterialContribution.events` 登记，
 * 页面级事件（`pageLoad` / `pageUnload`）由 `actions.ts` 的 `PAGE_EVENTS` 单独给出，
 * 不走物料声明。
 */
export interface EventDefinition {
  /** 事件名标识，如 `'click'`、`'change'`；与 `EventConnection.eventName` 对应 */
  name: string
  /** 事件在编辑器里的显示标题，如 `'点击事件'` */
  title: string
  /** 事件触发时携带的参数列表（可选） */
  parameters?: EventParameter[]
  /** 事件用途描述（可选） */
  description?: string
}

/**
 * 把组件 emit 出来的实参列表折叠成表达式里的 `event`。
 *
 * 参数名取自物料的事件声明，按位置对齐：声明了 2 个而组件只 emit 1 个，另一位取
 * `undefined`；组件多发出的实参丢弃。
 *
 * 刻意不做「没声明就塞进 `$args`」这类兜底：那会把「物料忘了声明参数」表现成
 * 表达式里凭空少一个变量、要跑到运行时才发现，而不是在设计期就能从参数表里看出来。
 *
 * 用 null 原型对象承载：参数名来自物料作者输入，直接放进普通对象可能触发
 * `__proto__` 之类的原型污染。
 *
 * @param parameters 事件声明的参数列表；未声明时结果为空对象
 * @param args 组件实际 emit 的实参
 * @returns 以参数名为键的事件载荷
 */
export function buildEventPayload(
  parameters: readonly EventParameter[] | undefined,
  args: readonly unknown[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = Object.create(null)

  for (const [index, parameter] of (parameters ?? []).entries()) {
    payload[parameter.name] = args[index]
  }

  return payload
}
