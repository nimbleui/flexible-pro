import type { DocumentModel } from '@lc/schema'
import type { Point } from './geometry'
import type { VersionOpenPayload } from './services/version'

/** 文档变更通知载荷 */
export interface DocumentChangePayload {
  /** 变更后的文档快照 */
  model: Readonly<DocumentModel>
}

/** 手势结束通知载荷 */
export interface GestureEndPayload {
  /** 事务 owner（插件名） */
  owner: string
  /** 事务名称 */
  label: string
  /** 是否提交；false 表示被取消 */
  committed: boolean
}

/** 插件激活载荷 */
export interface PluginActivatedPayload {
  /** 插件逻辑名 */
  plugin: string
  /** 实例 id */
  instanceId: string
}

/** 插件激活失败载荷 */
export interface PluginFailedPayload {
  /** 插件逻辑名 */
  plugin: string
  /** 失败原因 */
  error: unknown
}

/** 物料拖入画布载荷 */
export interface CanvasDropPayload {
  /** 物料名，对应 material 注册表的 key */
  materialName: string
  /** 落点世界坐标 */
  world: Point
  /** 落点屏幕坐标（画布视口本地） */
  screen: Point
}

/**
 * 平台事件表。
 *
 * 所有业务事件集中在这里声明，插件通过 `ctx.on` / `ctx.emit` 使用；
 * 禁止各插件自行 `declare module '@lc/kernel'`，避免事件名散落。
 */
declare module '@lc/kernel' {
  interface Events {
    /** 文档内容变化；手势预览与正式提交都会触发 */
    'document:change': (payload: DocumentChangePayload) => void
    /** 选中集变化 */
    'selection:change': (ids: readonly string[]) => void
    /** 画布手势结束；用于埋点、教程、协作适配 */
    'canvas:gestureEnd': (payload: GestureEndPayload) => void
    /** 插件激活成功 */
    'plugin:activated': (payload: PluginActivatedPayload) => void
    /** 插件激活失败 */
    'plugin:failed': (payload: PluginFailedPayload) => void
    /**
     * 物料拖入画布。
     *
     * 由画布宿主在 drop 时触发；画布插件返回 true 表示已消费。
     */
    'canvas:drop': (payload: CanvasDropPayload) => boolean | void
    /** 切换命令面板 */
    'palette:toggle': () => void
    /** 打开版本面板并聚焦指定分区；命令只广播意图，具体动作由面板执行 */
    'version:open': (payload: VersionOpenPayload) => void
  }
}
