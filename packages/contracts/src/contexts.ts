import type { Context, PluginDefinition } from '@lc/kernel'
import { installServiceAccessors } from '@lc/kernel'
import type { ExpressionEngine } from '@lc/schema'
import type { ContributionService } from './contribution'
import type { CanvasService, SnapService } from './services/canvas'
import type { CommandService } from './services/command'
import type { DataSourceService } from './services/datasource'
import type { DocumentService } from './services/document'
import type { HistoryService } from './services/history'
import type { KeybindingService } from './services/keybinding'
import type { LoaderService } from './services/loader'
import type { MaterialService } from './services/material'
import type { ModuleService } from './services/modules'
import type { RendererService } from './services/renderer'
import type { SelectionService } from './services/selection'
import type { SetterService } from './services/setter'
import type { WorkspaceService } from './services/workspace'

/**
 * 把平台服务挂到内核 Context 上。
 *
 * 所有 Context 扩展集中在本包，插件不得各自 declare module。
 * 应用级服务声明为必选（preset-designer 安装后必然存在）；
 * Realm 级服务声明为可选，避免 AppContext 谎报能力。
 */
declare module '@lc/kernel' {
  interface Context {
    /** 插件装载器；应用级 */
    loader: LoaderService
    /** 声明式贡献查询；应用级 */
    contribution: ContributionService
    /** 模块懒加载；应用级 */
    modules: ModuleService
    /** 物料注册表；应用级 */
    material: MaterialService
    /** 设计时命令；应用级 */
    command: CommandService
    /** schema → 组件；由 @lc/vue 提供 */
    renderer: RendererService
    /** 工作区 / Realm 管理；应用级 */
    workspace: WorkspaceService
    /** 表达式求值；应用级 */
    expression: ExpressionEngine
    /** 属性设置器注册表；应用级 */
    setter: SetterService
    /** 快捷键服务；应用级 */
    keybinding: KeybindingService

    /** 文档服务；EditorContext 中必选 */
    document?: DocumentService
    /** 撤销/重做；EditorContext 中必选 */
    history?: HistoryService
    /** 选中集；EditorContext 中必选 */
    selection?: SelectionService
    /** 数据源运行时；EditorContext 中由 workspace 装载 */
    dataSource?: DataSourceService
    /** 画布微内核；CanvasContext 中必选 */
    canvas?: CanvasService
    /** 吸附服务；仅安装 canvas-snap 后存在 */
    snap?: SnapService
  }
}

/** 应用级上下文：只有全局服务 */
export type AppContext = Context

/** 文档级上下文：Realm 内文档服务必选 */
export interface EditorContext extends Context {
  /** 当前文档服务 */
  document: DocumentService
  /** 撤销/重做 */
  history: HistoryService
  /** 选中集 */
  selection: SelectionService
  /** 数据源运行时 */
  dataSource: DataSourceService
}

/** 画布级上下文：CanvasRealm 内画布服务必选 */
export interface CanvasContext extends EditorContext {
  /** 画布微内核入口 */
  canvas: CanvasService
}

/**
 * 编辑器插件类型糖：把 apply 的 ctx 收窄为 EditorContext。
 *
 * 只做类型收窄，不改变运行时；应用级插件继续用 `definePlugin`。
 */
export function defineEditorPlugin<S>(
  definition: PluginDefinition<S, EditorContext>,
): PluginDefinition<S, EditorContext> {
  return definition
}

/** 画布插件类型糖：把 apply 的 ctx 收窄为 CanvasContext。 */
export function defineCanvasPlugin<S>(
  definition: PluginDefinition<S, CanvasContext>,
): PluginDefinition<S, CanvasContext> {
  return definition
}

/** 平台服务名清单；内核据此安装属性访问器 */
export const SERVICE_NAMES = [
  'loader',
  'contribution',
  'modules',
  'material',
  'command',
  'renderer',
  'workspace',
  'expression',
  'setter',
  'keybinding',
  'document',
  'history',
  'selection',
  'dataSource',
  'canvas',
  'snap',
] as const

/**
 * 安装 `ctx.<service>` 属性访问器。
 *
 * 契约层唯一的运行时行为：只把声明合并出来的属性接到 `ctx.get` 上，
 * 不持有状态、不做校验；应用启动时调用一次即可。
 */
export function installContextServices(): void {
  installServiceAccessors(SERVICE_NAMES)
}
