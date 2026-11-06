import type { FlowDefinition } from './flow'

/**
 * 页面事件绑定流程图的候选描述。
 *
 * 绑定关系本身是 `EventConnection.flowId` 一个字符串，本模块只回答另一件事：
 * 「这个 id 现在对用户该显示成什么」。两处界面（右栏事件页签的下拉、底部事件流的角标）
 * 都要显示同样的文字，各写一遍迟早对不上——尤其「草稿」与「已删除」这两种最容易误读的状态。
 */

/** 一条绑定候选 */
export interface FlowBindingOption {
  /** 图 id，即写进 `connection.flowId` 的值 */
  value: string
  /** 图名；图已不存在时是可直接展示的说明文案 */
  label: string
  /** 状态说明，出现在下拉项的 title 里；已发布的图为空串 */
  description: string
  /** 选了这条能不能立刻生效：草稿与已删除的图都不会被执行 */
  effective: boolean
}

/**
 * 列出可绑定的图，并把「当前值」也保证出现在结果里。
 *
 * 草稿必须列出来但要说清还不生效：把它藏起来，作者只会发现下拉里凭空少一张图，
 * 然后去怀疑页面；列出来并标注，下一步该做什么（去发布）就是可见的。
 *
 * 当前绑定的图如果已经不在清单里（被删了、或不属于本项目），仍然补一条占位——
 * 否则下拉显示「未选择」，那条永远不会生效的悬空引用就彻底看不见了，
 * 而校验明明已经报了它。
 *
 * @param flows 当前项目里的全部图，含草稿
 * @param currentFlowId 连接上现有的绑定值
 */
export function listFlowBindingOptions(
  flows: readonly FlowDefinition[],
  currentFlowId?: string,
): FlowBindingOption[] {
  const options: FlowBindingOption[] = flows.map((flow) => ({
    value: flow.id,
    label: flow.name,
    description: flow.status === 'published' ? '' : '草稿，发布后页面事件才会执行它',
    effective: flow.status === 'published',
  }))

  if (!currentFlowId || options.some((option) => option.value === currentFlowId)) return options

  options.unshift({
    value: currentFlowId,
    label: `流程图 ${currentFlowId}（已不存在）`,
    description: '绑定的图已被删除，这个事件只会执行动作链',
    effective: false,
  })

  return options
}

/**
 * 当前绑定的展示文案；没绑时返回空串。
 *
 * 调用方只需要这一句，不需要自己判断「id 查不到」与「id 是草稿」的差别。
 */
export function flowBindingSummary(
  flows: readonly FlowDefinition[],
  flowId: string | undefined,
): string {
  if (!flowId) return ''

  const flow = flows.find((item) => item.id === flowId)
  if (!flow) return `流程图 ${flowId}（已不存在）`
  if (flow.status !== 'published') return `流程「${flow.name}」（草稿）`

  return `流程「${flow.name}」`
}
