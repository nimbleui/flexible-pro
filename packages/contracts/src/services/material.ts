import type { JsonSchema } from '../json'
import type { NodeSchema } from '@lc/schema'
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
  /** 是否可作为容器接收子节点 */
  container?: boolean
  /** 允许的父物料；空表示不限制 */
  allowedParents?: string[]
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
