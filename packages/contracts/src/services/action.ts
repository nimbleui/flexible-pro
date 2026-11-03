import type { Disposable } from '@lc/kernel'
import type { ActionDeclaration, ExpressionScope } from '@lc/schema'

/**
 * 动作执行服务（Realm 级）。
 * ---
 * 把 `PageSchema.connections` + `PageSchema.actions` 这套**声明**变成**执行**。
 *
 * 分层原则：本服务只负责「按序走完一条链、处理条件与失败策略、把每步记录下来」，
 * 具体某个动作类型做什么由 {@link ActionHandler} 提供。因此新增一种动作能力
 * 只需要注册一个处理器，不需要改执行器——这与状态、数据源、提示、路由各自
 * 独立成服务的划分是一致的。
 *
 * 执行**只发生在运行时**（预览 / 播放器）。设计器画布不触发事件，否则编辑
 * 一个按钮就会真的跳转页面。
 */

/** 一次事件触发携带的参数；进入表达式作用域的 `event` */
export type ActionEventPayload = Readonly<Record<string, unknown>>

/**
 * 单个动作执行完对当前链的影响。
 *
 * 只有两种：继续，或终止当前链。`flow.end` 与分支内部的提前结束都返回 `stop`。
 * 处理器返回 `void` 等价于 `continue`，让绝大多数处理器不必关心控制流。
 */
export type ActionOutcome = { readonly kind: 'continue' } | { readonly kind: 'stop' }

/** 继续执行链上的下一个动作 */
export const ACTION_CONTINUE: ActionOutcome = { kind: 'continue' }

/** 终止当前链；后续动作不再执行，整条链的结果记为 `stopped` 而非失败 */
export const ACTION_STOP: ActionOutcome = { kind: 'stop' }

/** 传给处理器的执行输入 */
export interface ActionHandlerInput {
  /** 当前动作声明 */
  readonly action: ActionDeclaration
  /**
   * 已解析的配置：`{{ }}` 模板与表达式对象都已求值完毕。
   *
   * 处理器拿到的是最终值，不需要自己调用表达式引擎；这样「config 里的字符串
   * 要不要插值」这条规则只存在一处。
   */
  readonly config: Readonly<Record<string, unknown>>
  /** 本步的表达式作用域；处理器需要额外求值时使用 */
  readonly scope: ExpressionScope
  /**
   * 执行另一个动作，用于 `flow.condition` / `flow.sequence` 这类控制流动作。
   *
   * 被调用的动作会走完整的条件判断与失败策略；返回它对当前链的影响，
   * 控制流处理器据此决定是否把 `stop` 向上传递。
   *
   * 引用的动作 id 不存在时，执行器把整条链记为失败并返回 `stop`——处理器
   * **不需要**为此写分支，照原样把返回值传上去即可。
   */
  runAction(actionId: string): Promise<ActionOutcome>
}

/**
 * 动作处理器：一种动作类型的执行逻辑。
 *
 * 处理器**不应抛错来表达业务失败之外的情况**：抛出的异常一律被执行器捕获并按
 * 动作的 `onError` 策略处置。需要「停下来」时返回 {@link ACTION_STOP}，
 * 那是控制流而不是错误。
 */
export interface ActionHandler {
  /** 处理的动作类型，与 `ActionDeclaration.type` 对应 */
  readonly type: string
  /**
   * 执行动作。
   *
   * @param input 动作声明、已解析配置、作用域与嵌套执行入口
   * @returns 对当前链的影响；返回 `void` 视为继续
   * @throws 执行失败时抛出，由执行器按 `onError` 处置
   */
  execute(input: ActionHandlerInput): Promise<ActionOutcome | void>
}

/** 单步执行记录，供调试面板与 devtools 展示 */
export interface ActionStepRecord {
  /** 动作 id */
  readonly actionId: string
  /** 动作类型 */
  readonly type: string
  /** 本步结果 */
  readonly outcome: 'success' | 'skipped' | 'failed'
  /** 失败原因；仅 `outcome === 'failed'` 时有值 */
  readonly message?: string
  /** 耗时（毫秒）；跳过的动作为 0 */
  readonly durationMs: number
  /** 嵌套深度；顶层链上的动作为 0，`flow.sequence` 成员为 1，依此类推 */
  readonly depth: number
}

/** 一条链的执行结果 */
export type ActionRunResult =
  | {
      /** 所有动作执行完毕 */
      readonly status: 'completed'
      readonly steps: number
    }
  | {
      /** 遇到 `flow.end`，主动提前结束 */
      readonly status: 'stopped'
      readonly steps: number
    }
  | {
      /** 某个动作失败且策略为 `stop`（默认） */
      readonly status: 'failed'
      readonly steps: number
      readonly actionId: string
      readonly message: string
    }
  | {
      /** 执行被强制中止 */
      readonly status: 'aborted'
      readonly steps: number
      /**
       * 中止原因。
       *
       * `step-limit` 表示动作步数超出上限，通常意味着动作引用成环——设计期校验
       * 应当已经拦住，这里兜住「未校验的 schema 直接执行」和插件自定义动作里
       * 校验看不见的引用。`disposed` 表示执行环境已销毁。`timeout` 只有流程图
       * 执行器会产出，含义是超出 `FlowSettings.timeoutSeconds`。
       */
      readonly reason: 'step-limit' | 'disposed' | 'timeout'
    }

/**
 * 动作执行服务。
 *
 * 所有方法都**不抛错**：一条事件链失败不应该把触发它的组件渲染一起带崩。
 * 失败信息通过返回值与 {@link ActionService.onDidStep} 暴露。
 */
export interface ActionService {
  /**
   * 按「来源节点 + 事件名」触发所有匹配且启用的事件连接。
   *
   * 校验层已保证同一 `sourceNodeId:eventName` 不会被两条连接重复绑定，
   * 因此正常情况下至多执行一条链；返回数组是为了不把这条约束写死在类型里。
   *
   * @param sourceNodeId 事件来源节点 id；页面级事件传 `'page'`
   * @param eventName 事件名
   * @param event 事件参数，进入表达式作用域的 `event`
   */
  trigger(
    sourceNodeId: string,
    eventName: string,
    event?: ActionEventPayload,
  ): Promise<ActionRunResult[]>

  /**
   * 执行指定连接，无视 `enabled`。
   *
   * 供调试面板「试运行」使用：停用的连接也需要能被单独验证。
   */
  run(connectionId: string, event?: ActionEventPayload): Promise<ActionRunResult>

  /**
   * 注册动作处理器；同一类型重复注册时后者覆盖前者。
   *
   * 覆盖是刻意的：内置动作允许被插件替换实现，否则「一切动作皆插件」只能加不能改。
   *
   * @returns 释放句柄； dispose 后该类型的处理器被移除，不会恢复被覆盖的旧实现
   */
  register(handler: ActionHandler): Disposable

  /**
   * 注册宿主作用域提供者。
   *
   * `$route` 之类随导航变化的值必须用 getter 而不是快照传入，否则一次注册
   * 就把路由永久钉在了注册那一刻。
   */
  setScopeProvider(provider: () => ExpressionScope): Disposable

  /**
   * 每执行完一步（含跳过与失败）通知一次。
   *
   * 通知顺序是**完成顺序**：嵌套动作（`flow.condition` 的分支、`flow.sequence` 的
   * 成员）先于包含它的父动作上报。用 {@link ActionStepRecord.depth} 可以把这个
   * 线性序列还原成树。
   */
  onDidStep(listener: (record: ActionStepRecord) => void): Disposable
}
