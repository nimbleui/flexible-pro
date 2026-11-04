import type { EventDefinition, NodeSchema, SlotDefinition } from '@lc/schema'
import type { JsonSchema } from '../json'
import type { Registry } from './registry'

/**
 * 物料贡献：插件在 manifest 中声明的组件元数据。
 *
 * 它是纯数据，装载器注册后物料面板即可展示，不依赖组件代码是否已下载。
 */
export interface MaterialContribution {
  /** 物料唯一名，建议带命名空间，如 `lc.stat` */
  name: string
  /** 展示名，支持 i18n key */
  title: string
  /** 物料面板分组 */
  category: string
  /** 图标名，来自共享图标注册表 */
  icon?: string
  /** 属性 schema；未加载组件时也能生成属性面板 */
  props: JsonSchema
  /** 组件 ESM 模块声明值，与插件名拼接为全局模块 key */
  module: string
  /** 拖入画布时生成的默认节点；缺省由 props 默认值生成 */
  snippet?: NodeSchema
  /**
   * 点击时执行的命令 id。
   *
   * 设置后该条目是「打开编辑器 UI」的入口而不是画布节点：面板不发起拖拽，
   * 点击直接交给命令服务。适用于自定义函数这类无需在画布上占位的物料。
   */
  clickCommand?: string
  /** 是否可作为容器接收子节点 */
  container?: boolean
  /**
   * 组件对外暴露的具名插槽声明。
   *
   * 与 `NodeSchema.slots`（`Record<插槽名, 子节点 id[]>`）是一对：本字段说「这个组件
   * 有哪些内容分发点」，节点侧说「这个实例的那些点里放了谁」。类型复用 `@lc/schema`
   * 的 `SlotDefinition`，不在这里另立一套——自定义组件蓝图
   * （`ComponentSchema.slots`）用的就是它。
   *
   * 落位与 `container` 相邻而不是与 `props` 并列，是因为两者共同回答「能不能往里放、
   * 放到哪一格」：`container` 决定命中测试是否把该节点当容器，`slots` 决定容器内部的
   * 具名分发点。
   *
   * 执行点在拖入：命中容器后由 `canvas-drop` 按 `region` 判定落到哪一格，写进
   * `parent.slots[<name>]`；命中的那一格被 `accepts` 拒绝或被 `maxChildren` 占满时，
   * 降级到名为 `default` 的插槽，两者都不可用才回落到 `children`（见
   * `canvas-drop/src/slot-target.ts`）。校验器仍只检查插槽引用的节点是否存在，
   * 不检查插槽名是否已声明；渲染层也把 children 与全部插槽压成同一份默认插槽内容
   * （`vue/src/render/tree.ts:49-51`），所以「放进 header」目前只改变数据落档位置，
   * 组件还收不到分开的具名插槽。
   */
  slots?: SlotDefinition[]
  /** 允许的父物料；空表示不限制 */
  allowedParents?: string[]
  /**
   * 组件对外事件声明。
   *
   * 两处消费：事件流面板据此列出可选的事件名与参数；运行时的预览渲染器据此把
   * 组件 emit 的实参按位置折叠成表达式里的 `event`（见 `buildEventPayload`）。
   *
   * 因此**声明与实际 emit 必须一致**：没声明的参数在表达式里读不到，声明了却没
   * emit 的参数恒为 `undefined`。复合物料靠这个字段把自己蓝图里的交互暴露给页面。
   */
  events?: EventDefinition[]
  /** 同名物料冲突时的优先级，默认先注册者胜出 */
  priority?: number
}

/**
 * 运行时物料条目：贡献 + 解析信息。
 *
 * `moduleKey` 由物料服务在注册时计算，渲染器直接用它调用 ModuleService。
 */
export interface MaterialEntry extends MaterialContribution {
  /** 贡献来源插件名，用于诊断与卸载 */
  plugin: string
  /** 全局模块 key，= moduleKey(plugin, contribution.module) */
  moduleKey: string
}

/** 已加载的物料模块 */
export interface ResolvedMaterial {
  /** 物料条目 */
  entry: MaterialEntry
  /** 解析到的组件对象（框架无关，Vue 适配层负责强转） */
  component: unknown
}

/**
 * 物料服务。
 *
 * 只负责「元数据注册 + 懒加载组件」，不负责渲染；
 * 渲染由 `renderer` 服务与宿主组件完成。
 */
export interface MaterialService extends Registry<MaterialEntry> {
  /** 加载物料组件；并发调用共享同一个 Promise */
  ensure(name: string): Promise<ResolvedMaterial | undefined>
}
