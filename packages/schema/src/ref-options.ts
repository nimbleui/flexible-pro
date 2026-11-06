import type { ActionRefSource } from './actions'
import type { FlowDefinition } from './flow'
import type { PageSchema } from './page'
import { findActionDefinition } from './actions'

/** 一个引用候选 */
export interface RefOption {
  /** 写进 config 的值 */
  value: string
  /** 展示名 */
  label: string
  /** 补充说明；展示在选项后面，帮作者区分同名项 */
  description?: string
}

/** `listRefOptions` 的输入 */
export interface RefOptionsInput {
  /**
   * 当前页面 schema；`variable` / `dataSource` / `action` 三类只从它算出来。
   *
   * 做成可选：`flow` 一类根本不读它，而候选来自宿主。
   * 要求调用方为它编一份假 schema，只会逼出 `as unknown as` 这种假类型。
   */
  schema?: PageSchema
  /**
   * 流程图清单；仅 `ref === 'flow'` 时读取。
   *
   * 刻意做成可选而不是让 schema 带上图清单：图是独立发版的资产，不属于任何页面文档，
   * 把它塞进 `PageSchema` 会让「页面里有哪些图」变成两处各自维护的事实。
   */
  flows?: readonly FlowDefinition[]
  /**
   * 从候选里排除的 value。
   *
   * 分支目标与序列成员都要求排除动作自身——指向自己就是环，与其让作者选出来再被校验拦下，
   * 不如在选择器里就不出现。
   */
  exclude?: string
}

/**
 * 取一个引用型字段的候选列表。
 *
 * 纯函数：不读服务、不碰运行时状态，输入只有页面 schema 与（可选）宿主给的图清单。
 * 这样两个面板（事件流、流程编辑器）拿到的是同一套候选，也才能脱单测覆盖。
 *
 * 来源需要 `schema` 却没传时返回空列表而不是抛错：候选缺失是可以在面板上表现出来的
 * 状态，而一次抛错会让整条右栏跟着崩掉。
 *
 * 顺序有含义：`action` 按文档结构顺序而不是对象键顺序，作者在下拉里找一项靠的是
 * 「它排在第几个」，字典序会把相邻的两条动作打散。
 *
 * @param source 候选来源
 * @param input 输入
 * @returns 展示顺序的候选；来源没有对应声明时返回空数组
 */
export function listRefOptions(source: ActionRefSource, input: RefOptionsInput): RefOption[] {
  const { exclude } = input
  const options: RefOption[] = []

  switch (source) {
    case 'variable': {
      for (const variable of input.schema?.variables ?? []) {
        if (variable.name === exclude) continue
        options.push({
          value: variable.name,
          label: variable.name,
          description: variable.description,
        })
      }
      return options
    }

    case 'dataSource': {
      for (const dataSource of input.schema?.datasources ?? []) {
        if (dataSource.id === exclude) continue
        options.push({
          value: dataSource.id,
          label: dataSource.id,
          description: dataSource.type,
        })
      }
      return options
    }

    case 'action': {
      for (const action of Object.values(input.schema?.actions ?? {})) {
        if (action.id === exclude) continue
        options.push({
          value: action.id,
          label: action.name || findActionDefinition(action.type)?.title || action.type,
          description: action.id,
        })
      }
      return options
    }

    case 'flow': {
      for (const flow of input.flows ?? []) {
        // 子流程只认已发布：指向草稿是个不会报错的死分支，运行时匹配不到任何东西，
        // 与其让作者选完再猜为什么没反应，不如根本不出现。
        // 页面事件的绑定下拉是另一个消费方，它要把草稿列出来并标注状态，不走这条规则。
        if (flow.status !== 'published') continue
        if (flow.id === exclude) continue
        options.push({ value: flow.id, label: flow.name, description: flow.description })
      }
      return options
    }
  }
}
