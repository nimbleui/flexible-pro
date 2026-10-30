import type { Disposable } from '@lc/kernel'
import type { Rect, Size } from '@lc/schema'
import type { CanvasContext } from './contexts'
import type { JsonSchema } from './json'
import type { Point } from './geometry'
import type { ViewportState } from './services/canvas'

/** 事件分发阶段；键盘事件也走 capture/target/bubble */
export type PointerPhase = 'capture' | 'target' | 'bubble'

/** 修饰键快照 */
export interface CanvasModifiers {
  /** Alt；画布插件约定按住 Alt 临时禁用吸附 */
  alt: boolean
  /** Ctrl */
  ctrl: boolean
  /** Meta（⌘） */
  meta: boolean
  /** Shift；画布插件约定用于轴向/角度约束 */
  shift: boolean
}

/** 输入事件公共字段 */
export interface CanvasEventBase {
  /** 分发阶段 */
  phase: PointerPhase
  /** 修饰键快照 */
  modifiers: CanvasModifiers
  /** 命中的节点；覆盖层手柄另走 targetHandleId */
  targetNodeId?: string
  /** 阻止浏览器默认行为；只有确认消费时才调用 */
  preventDefault(): void
  /** 阻止后续处理器；慎用 */
  stopPropagation(): void
}

/** 指针 / 滚轮 / 右键事件 */
export interface CanvasPointerEvent extends CanvasEventBase {
  /** 事件类型 */
  type:
    | 'pointerdown'
    | 'pointermove'
    | 'pointerup'
    | 'pointercancel'
    | 'wheel'
    | 'click'
    | 'dblclick'
    | 'contextmenu'
  /** 屏幕坐标（画布视口本地） */
  screen: Point
  /** 世界坐标，已过逆矩阵 */
  world: Point
  /** 相对上一次事件的屏幕位移 */
  delta: Point
  /** PointerEvent.buttons 快照 */
  buttons: number
  /** 命中的手柄 id；不是手柄时为 undefined */
  targetHandleId?: string
  /** 指针 id，多指手势用 */
  pointerId: number
  /** 原始事件；仅用于 preventDefault / 读取 pressure 等 */
  originalEvent: PointerEvent | WheelEvent | MouseEvent
}

/** 键盘事件 */
export interface CanvasKeyboardEvent extends CanvasEventBase {
  /** 事件类型 */
  type: 'keydown' | 'keyup'
  /** KeyboardEvent.key，如 ArrowLeft、Delete */
  key: string
  /** KeyboardEvent.code，布局无关 */
  code: string
  /** 是否长按重复 */
  repeat: boolean
  /** 原始键盘事件 */
  originalEvent: KeyboardEvent
}

/** 画布输入事件联合 */
export type CanvasInputEvent = CanvasPointerEvent | CanvasKeyboardEvent

/** 类型守卫：区分指针事件与键盘事件 */
export function isPointerEvent(event: CanvasInputEvent): event is CanvasPointerEvent {
  return event.type !== 'keydown' && event.type !== 'keyup'
}

/**
 * 交互处理器返回值：
 * - `pass` / void：不处理，继续后续处理器
 * - `handled`：消费本次事件，阻止同阶段后续处理器
 * - `stop`：终止整条分发链
 *
 * 骨架实现将 `handled` 视为跨阶段消费，以保证「手柄优先于拖拽」这类
 * 冲突矩阵可预测；文档允许的更宽松规则（同阶段消费）留给后续调优。
 */
export type InteractionResult = 'pass' | 'handled' | 'stop' | void

/** 交互处理器契约 */
export interface InteractionHandler<E extends CanvasInputEvent = CanvasPointerEvent> {
  /** 全局唯一 id，建议 `<plugin>.<gesture>` */
  id: string
  /** 默认 bubble；手柄类用 target/capture */
  phase?: PointerPhase
  /** 同 phase 内越大越先执行 @default 0 */
  priority?: number
  /** 廉价纯函数；禁止 DOM 测量、禁止异步 */
  when?(event: E, ctx: CanvasContext): boolean
  /** 处理事件；必须是同步的低开销逻辑 */
  handle(event: E, ctx: CanvasContext): InteractionResult
}

/** 手势接管回调：pointerdown 返回 handled 后进入 */
export interface GestureCallbacks {
  /** 手势中的 pointermove */
  onMove(event: CanvasPointerEvent): void
  /** 手势结束；commit=false 表示 Esc / pointercancel */
  onFinish(commit: boolean): void
}

/** 图层带，决定基础 z-order */
export type LayerBand =
  'background' | 'content' | 'selection' | 'guides' | 'handles' | 'preview' | 'hud' | 'modal'

/**
 * 覆盖层契约。
 *
 * 覆盖层在屏幕空间渲染，通过 `frame.viewport` 投影；不要给覆盖层套 scale(zoom)。
 */
export interface CanvasLayer {
  /** 全局唯一 id */
  id: string
  /** 图层带 */
  band: LayerBand
  /** 同 band 内排序，越大越靠上 @default 0 */
  zIndex?: number
  /** none=整层穿透；children=容器穿透、子元素可命中；auto=整层命中 @default 'none' */
  pointerEvents?: 'none' | 'children' | 'auto'
  /** 可见条件；廉价纯函数，每个渲染帧调用 */
  visible?(frame: CanvasFrame): boolean
  /** 覆盖层模块；首次可见时加载，默认导出为 Vue 组件 */
  load(): Promise<unknown>
}

/** 覆盖层渲染帧快照 */
export interface CanvasFrame {
  /** 只读视口快照 */
  viewport: Readonly<ViewportState>
  /** 当前选中 id */
  selection: readonly string[]
  /** 当前吸附结果；没有吸附插件时为 null */
  snap: SnapResult | null
  /** 画布尺寸（屏幕像素） */
  size: Size
}

/** 吸附轴 */
export type SnapAxis = 'x' | 'y' | 'angle' | 'distance'

/** 右键菜单的目标 */
export interface CanvasMenuTarget {
  /** 命中的节点 id；画布空白处为 undefined */
  nodeId?: string
  /** 锚点的屏幕坐标（舞台本地） */
  screen: Point
  /** 锚点的世界坐标 */
  world: Point
}

/**
 * 右键菜单项。
 *
 * 项目按 `order` 升序排列（相同则按注册顺序），相邻两项 `group` 不同时自动插入分隔线，
 * 所以 group 只用来分组、order 决定组内与组间位置。
 */
export interface CanvasMenuItem {
  /** 唯一 id */
  id: string
  /** 菜单文案；省略时取 `command` 的标题 */
  title?: string
  /** 点击执行的命令 id；两者都不给则项目只是分隔标题 */
  command?: string
  /** 分组名，用于生成分隔线 @default 'default' */
  group?: string
  /** 排序，越小越靠上 @default 0 */
  order?: number
  /** 是否显示；省略时始终显示 */
  visible?: (target: CanvasMenuTarget) => boolean
  /** 是否可用；省略时按命令的 enabled 判定 */
  enabled?: (target: CanvasMenuTarget) => boolean
}

/**
 * 打开中的右键菜单状态在画布设置里的 id。
 *
 * 值是 `CanvasMenuTarget | null`：菜单覆盖层读它渲染，交互处理器在 contextmenu
 * 事件里写入。放在设置服务而不是插件内部状态，宿主与其他插件都能观察开合。
 */
export const CANVAS_CONTEXT_MENU_STATE = 'canvas-context-menu.state'

/** 吸附候选点 */
export interface SnapCandidate {
  /** 吸附轴 */
  axis: SnapAxis
  /** 世界坐标值；angle 用弧度，distance 用世界像素 */
  value: number
  /** 来源 id，用于调试与辅助线样式 */
  source: string
  /**
   * 吸附分层优先级：先按优先级从高到低分层，只在最高层内取距离最近者。
   *
   * 存在分层而不是纯距离排序，是因为网格候选由被拖元素的边推导、按构造总在阈值内且距离极小，
   * 纯距离会让元素对齐永远输给网格。约定：网格 0、其他元素 1、参考线更高。
   *
   * @default 0
   */
  priority?: number
  /** 候选的显示范围，辅助线只画这一段 */
  range?: [number, number]
  /**
   * 是否为该候选绘制辅助线。
   *
   * 网格只吸附不画线：网格本身已由 canvas-grid 可见，再画一条只会贴在被拖元素自己的边上。
   *
   * @default true
   */
  showGuide?: boolean
}

/** 吸附计算上下文 */
export interface SnapContext {
  /** 当前缩放；阈值必须用屏幕像素换算 */
  readonly zoom: number
  /** 当前视口世界矩形；providers 必须据此裁剪候选 */
  readonly viewportRect: Rect
  /** 正在移动的世界矩形 */
  readonly moving: readonly Rect[]
  /** 世界单位阈值（= thresholdScreenPx / zoom），provider 用它裁剪候选 */
  readonly thresholdWorld: number
  /** 正在移动的节点 id；元素提供者用它排除自身 */
  readonly movingIds?: readonly string[]
}

/** 吸附提供者；每个插件可注册多个来源（网格、节点、参考线） */
export interface SnapProvider {
  /** 全局唯一 id */
  id: string
  /** 返回候选点；必须限制在当前视口附近，避免全量扫描 */
  getCandidates(context: SnapContext): readonly SnapCandidate[]
}

/** 吸附输入 */
export interface SnapInput {
  /** 正在移动的矩形（世界坐标） */
  rects: readonly Rect[]
  /** 当前缩放 */
  zoom: number
  /** 当前视口世界矩形 */
  viewportRect: Rect
  /** 正在移动的节点 id；元素提供者排除自身用 */
  movingIds?: readonly string[]
}

/** 吸附辅助线 */
export interface SnapGuide {
  /** 轴线 */
  axis: 'x' | 'y'
  /** 世界坐标 */
  value: number
  /** 来源 id */
  source: string
  /** 显示范围（世界坐标） */
  range?: [number, number]
}

/** 吸附结果 */
export interface SnapResult {
  /** 需要施加的位移（世界像素） */
  delta: Point
  /** 需要显示的辅助线 */
  guides: readonly SnapGuide[]
  /** 是否命中任何吸附 */
  matched: boolean
}

/** 画布设置项 */
export interface CanvasSetting<T = unknown> {
  /** 设置 id，建议与插件同名 */
  id: string
  /** 展示名 */
  title: string
  /** 作用域：用户偏好 / 工作区 / 文档 */
  scope: 'user' | 'workspace' | 'document'
  /** 表单 schema */
  schema: JsonSchema
  /** 默认值 */
  default: T
  /** 是否允许租户策略锁定 */
  lockable?: boolean
}

/**
 * 画布能力贡献：manifest 中声明，CanvasHost 按文档实例化。
 *
 * 注意它只是「装什么」的声明，真正的插件定义由 module 导出。
 */
export interface CanvasFeatureContribution {
  /** 能力 id，建议与插件名一致，如 `zoom` */
  id: string
  /** 展示名 */
  title: string
  /** 插件模块声明值 */
  module: string
  /** 默认启用 */
  defaultEnabled?: boolean
  /** 装配顺序，越小越先挂载 @default 0 */
  order?: number
  /** 依赖的服务名，用于依赖图校验 */
  requires?: string[]
  /** 传给插件的配置 */
  config?: unknown
}

/** 画布预设：保存「默认启用哪些 feature、顺序与配置」，不含插件代码 */
export interface CanvasProfileContribution {
  /** 预设 id */
  id: string
  /** 展示名 */
  title: string
  /** 是否默认预设 */
  default?: boolean
  /** 能力清单 */
  features: Array<{
    /** 能力 id */
    id: string
    /** 是否启用 */
    enabled?: boolean
    /** 覆盖装配顺序 */
    order?: number
    /** 覆盖插件配置 */
    config?: unknown
  }>
}
