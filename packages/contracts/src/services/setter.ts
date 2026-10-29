import type { Disposable } from '@lc/kernel'
import type { PropOption, PropType } from '@lc/schema'
import type { Registry } from './registry'

/** 属性面板可渲染的基础控件类型 */
export type SetterKind = 'text' | 'number' | 'color' | 'toggle' | 'select'

/**
 * 属性设置器。
 *
 * 骨架阶段只描述「控件种类」而不加载自定义组件：属性面板据此渲染内置控件。
 * 后续接入自定义 setter 时，在这里增加 `component` 加载入口即可，契约不变。
 */
export interface SetterEntry {
  /** 唯一 id，建议 `setter.<propType>` */
  id: string
  /** 匹配的属性类型 */
  propType: PropType
  /** 控件种类 */
  kind: SetterKind
  /** 同类型下的优先级，越大越优先 @default 0 */
  priority?: number
  /** select 的可选项；未提供时由属性定义补充 */
  options?: PropOption[]
}

/**
 * 设置器注册表。
 *
 * 按属性类型解析：`resolve` 返回同类型中优先级最高的条目，
 * 类型未注册时由调用方回退到文本控件。
 */
export interface SetterService extends Registry<SetterEntry> {
  /** 解析属性类型对应的设置器 */
  resolve(propType: PropType): SetterEntry | undefined
}
