import type { Disposable } from '@lc/kernel'
import type { PageSchema } from '@lc/schema'
import type { CanvasContext, EditorContext } from '../contexts'

/** 打开文档 Realm 的选项 */
export interface RealmOptions {
  /** 文档 id；Realm 与审计/遥测都使用它 */
  documentId: string
  /** 文档标题 */
  title?: string
  /** 初始 schema；骨架阶段由宿主注入，生产环境由持久化服务加载 */
  schema?: PageSchema
  /** 编辑或只读预览；只读模式下文档服务拒绝写入 */
  mode?: 'edit' | 'preview'
}

/** 文档级 Realm */
export interface EditorRealm extends Disposable {
  /** Realm 唯一 id；审计/遥测/服务归属都用它 */
  readonly id: string
  /** 文档 id */
  readonly documentId: string
  /** 文档级上下文：document / history / selection 必选 */
  readonly context: EditorContext
  /** 创建该文档的主画布 Realm；每个文档一个 */
  createCanvasRealm(): CanvasRealm
}

/** 画布 Realm */
export interface CanvasRealm extends Disposable {
  /** 画布 Realm 唯一 id */
  readonly id: string
  /** 画布级上下文：canvas 必选 */
  readonly context: CanvasContext
}

/**
 * 工作区服务：创建/查找文档 Realm。
 *
 * Realm 由工作区通过 effect 托管，关闭文档或卸载父插件都会级联销毁；
 * 它不是裸 `fork()`，服务归属与审计都会带上 realmId。
 */
export interface WorkspaceService {
  /** 创建文档 Realm；生命周期由 workspace 的 effect 托管 */
  createEditorRealm(options: RealmOptions): EditorRealm
  /** 当前活动文档 Realm */
  readonly activeEditor: EditorRealm | undefined
  /** 按文档 id 查找 */
  getEditor(documentId: string): EditorRealm | undefined
  /** 列出全部打开的文档 Realm */
  listEditors(): readonly EditorRealm[]
  /** Realm 列表变化（打开/关闭） */
  onDidChange(listener: () => void): Disposable
}
