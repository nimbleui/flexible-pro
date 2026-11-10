import type { Disposable } from '@lc/kernel'
import type {
  CanvasFeatureContribution,
  CanvasProfileContribution,
} from './canvas-contributions'
import type { JsonSchema } from './json'
import type { SlotName } from './slots'
import type { MaterialContribution } from './services/material'

/**
 * 面板贡献：功能面板挂到宿主插槽。
 *
 * 面板组件在首次打开时加载，manifest 注册后入口即可出现。
 */
export interface PanelContribution {
  /** 面板 id，用于布局持久化与命令打开 */
  id: string
  /** 展示名 */
  title: string
  /** 宿主插槽名，必须是 SLOT 中声明的值 */
  slot: SlotName
  /** 图标名 */
  icon?: string
  /** 排序，越小越靠前 @default 0 */
  order?: number
  /** 面板组件模块声明值，打开面板时才加载 */
  module: string
  /** 显示条件；骨架阶段保留字段，宿主暂未求值 */
  when?: string
  /** 同 id 冲突时的优先级 @default 0 */
  priority?: number
}

/**
 * 工具栏按钮贡献。
 *
 * 按钮不直接携带逻辑，只声明要执行的命令 id，保证「命令是唯一执行入口」。
 */
export interface ToolbarContribution {
  /** 按钮 id */
  id: string
  /** 展示名 / tooltip */
  title: string
  /** 宿主插槽名，通常是 `designer.toolbar` */
  slot: SlotName
  /** 点击执行的命令 id */
  command: string
  /** 图标名 */
  icon?: string
  /** 排序，越小越靠前 @default 0 */
  order?: number
  /** 显示条件；骨架阶段保留字段，宿主暂未求值 */
  when?: string
}

/** 贡献值映射：point → 条目类型 */
export interface ContributionValueMap {
  /** 物料 */
  materials: MaterialContribution
  /** 面板 */
  panels: PanelContribution
  /** 工具栏按钮 */
  toolbar: ToolbarContribution
  /** 画布能力 */
  canvasFeatures: CanvasFeatureContribution
  /** 画布预设 */
  canvasProfiles: CanvasProfileContribution
}

/** 贡献点 */
export type ContributionPoint = keyof ContributionValueMap

/** 已安装后的运行时贡献条目 */
export interface ContributionItem<K extends ContributionPoint = ContributionPoint> {
  /** 贡献来源插件名 */
  plugin: string
  /** 贡献点 */
  point: K
  /** 贡献内容 */
  value: ContributionValueMap[K]
}

/**
 * 声明式贡献服务。
 *
 * - `register`：装载器在安装/启用插件时调用，纯数据注册，不执行插件代码
 * - `list`：宿主渲染时查询，已按 order / priority / 插件名排序
 */
export interface ContributionService {
  /**
   * 注册一组贡献；返回的 Disposable 会移除同批全部条目。
   *
   * @param plugin 声明这些贡献的插件 id
   * @param point 贡献点（如面板插槽或菜单）
   * @param items 该批次的条目；卸载时整批移除，避免孤儿条目
   */
  register<K extends ContributionPoint>(
    plugin: string,
    point: K,
    items: readonly ContributionValueMap[K][],
  ): Disposable
  /** 按贡献点列出条目（已排序） */
  list<K extends ContributionPoint>(point: K): readonly ContributionItem<K>[]
  /** 按宿主插槽列出面板条目（已排序） */
  listSlot(slot: SlotName): readonly ContributionItem<'panels'>[]
  /** 贡献变化通知；Slot 组件据此刷新 */
  onDidChange(listener: () => void): Disposable
}

/** 物料属性 schema 的别名，便于 manifest 作者引用 */
export type MaterialPropsSchema = JsonSchema
