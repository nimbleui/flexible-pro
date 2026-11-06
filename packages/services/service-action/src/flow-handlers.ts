import type { ActionHandler } from '@lc/contracts'
import { ACTION_CONTINUE, ACTION_STOP } from '@lc/contracts'
import {
  FLOW_CONDITION,
  FLOW_END,
  FLOW_PARALLEL,
  FLOW_SEQUENCE,
  FLOW_TRIGGER,
} from '@lc/schema'

/**
 * 控制流动作处理器。
 *
 * 这三个类型不需要任何外部能力（状态、请求、DOM），只依赖执行器提供的
 * `runAction` 嵌套入口，因此单独成文件、可以脱离内核直接测。
 *
 * `config` 已由执行器解析完毕：`flow.condition` 的 `expression` 已经是布尔值而不是
 * 表达式对象——校验层保证它必须是表达式形态，这里就不必再判断「是文本还是表达式」。
 */

/**
 * `flow.condition`：按条件选一条分支执行，之后回到原链继续。
 *
 * 分支目标缺省时等价于空操作——「只关心成立时做什么」是常见写法，不该为此
 * 强制填两个字段。
 */
export const flowConditionHandler: ActionHandler = {
  type: FLOW_CONDITION,

  async execute({ config, runAction }) {
    const branch = config.expression ? config.trueActionId : config.falseActionId
    if (typeof branch !== 'string' || branch === '') return ACTION_CONTINUE

    return runAction(branch)
  },
}

/**
 * `flow.sequence`：按顺序执行一组动作，作为分支目标复用。
 *
 * 成员动作返回 `stop`（例如序列里有 `flow.end`）时向上传递，让整条链一起停下——
 * 否则「子序列里的 flow.end」只会停掉子序列，与作者直觉相反。
 */
export const flowSequenceHandler: ActionHandler = {
  type: FLOW_SEQUENCE,

  async execute({ config, runAction }) {
    const members = config.actionIds
    if (!Array.isArray(members)) {
      throw new TypeError('flow.sequence 的 actionIds 必须是动作 id 数组')
    }

    for (const member of members) {
      if (typeof member !== 'string' || member === '') continue

      const outcome = await runAction(member)
      if (outcome.kind === 'stop') return outcome
    }

    return ACTION_CONTINUE
  },
}

/** `flow.end`：终止当前链 */
export const flowEndHandler: ActionHandler = {
  type: FLOW_END,

  async execute() {
    return ACTION_STOP
  },
}

/**
 * `flow.parallel`：并行扇出节点。
 *
 * 处理器本身什么都不做——真正的并发在流程图执行器里（按出边开工作协程）。存在的理由是
 * 「每个被访问到的节点都要有一条步记录」：少了它，调试面板里并行块会凭空消失，
 * 作者以为没执行。链式模型里没有这个类型，所以只会被图执行器命中。
 */
export const flowParallelHandler: ActionHandler = {
  type: FLOW_PARALLEL,

  async execute() {
    return ACTION_CONTINUE
  },
}

/**
 * `flow.trigger`：图的入口节点。
 *
 * 与 `flow.parallel` 同理由存在：它什么都不做，但必须有一条步记录，且必须**注册**——
 * 执行器对未注册类型按失败处理并停住整张图，少了这一个，任何已发布的图都会在第一个
 * 节点上失败，页面事件看起来「配了却没跑」。试运行路径自己注册过它，所以这个坑只在
 * 真实触发时暴露。
 */
export const flowTriggerHandler: ActionHandler = {
  type: FLOW_TRIGGER,

  async execute() {
    return ACTION_CONTINUE
  },
}

/** 执行器内置的处理器清单；注册时整体装入 */
export const FLOW_HANDLERS: readonly ActionHandler[] = [
  flowTriggerHandler,
  flowConditionHandler,
  flowSequenceHandler,
  flowParallelHandler,
  flowEndHandler,
]
