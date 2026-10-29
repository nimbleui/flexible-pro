import type { Disposable } from '@lc/kernel'
import type { Rect, SchemaPatch, Size } from '@lc/schema'
import type {
  CanvasInputEvent,
  CanvasLayer,
  CanvasSetting,
  GestureCallbacks,
  InteractionHandler,
  SnapInput,
  SnapProvider,
  SnapResult,
} from '../canvas-contributions'
import type { Point } from '../geometry'
import type { NodeFlagView } from '../nodes'
import type { SelectionService } from './selection'

/**
 * 二维仿射矩阵 `[a, b, c, d, e, f]`，与 CSS `matrix()` 参数顺序一致。
 *
 * 使用普通元组而不是 DOMMatrix：内核与测试环境（Node）不需要 DOM，
 * 渲染层把同一组数字直接交给 CSS transform。
 */
export type Matrix2D = readonly [number, number, number, number, number, number]

/**
 * 视口状态。
 *
 * `x` / `y` 表示「屏幕左上角对应的世界坐标」，缩放 / 旋转围绕它计算；
 * 变换顺序固定为 `translate * scale * rotate`，插件不得自行拼接矩阵。
 */
export interface ViewportState {
  /** 视口左上角对应的世界坐标 x */
  x: number
  /** 视口左上角对应的世界坐标 y */
  y: number
  /** 缩放倍数，1 表示 100% */
  zoom: number
  /** 视口旋转弧度；默认 0 */
  rotation: number
}

/**
 * 视口服务：world ↔ screen 的唯一换算入口。
 */
export interface ViewportService {
  /** 只读快照；不要直接改对象 */
  readonly state: Readonly<ViewportState>
  /** world → screen 的当前矩阵（CSS matrix 顺序） */
  readonly matrix: Matrix2D
  /** 画布可视区尺寸（屏幕像素） */
  readonly size: Size
  /** 视口中心对应的世界坐标 */
  readonly center: Point
  /** screen → world */
  screenToWorld(point: Point): Point
  /** world → screen */
  worldToScreen(point: Point): Point
  /** 围绕某个屏幕点缩放，保持该点下的世界坐标不动 */
  zoomAt(screen: Point, factor: number): void
  /** 平移，参数为屏幕像素 */
  panBy(delta: Point): void
  /** 缩放到容纳某个世界矩形 */
  fit(rect: Rect, padding?: number): void
  /** 设置视口；内部会 clamp 到 min/max zoom */
  set(next: Partial<ViewportState>): void
  /** 更新可视区尺寸；由 CanvasStage 的 ResizeObserver 调用 */
  setSize(size: Size): void
  /** 视口变化通知；覆盖层与状态栏据此刷新 */
  onDidChange(listener: () => void): Disposable
}

/**
 * 场景图：节点几何索引。
 *
 * 骨架阶段以 `layout.rect` 为权威几何来源（绝对定位画布），
 * 避免手势期间强制回流；流式布局接入后由渲染器补充 DOM 测量。
 */
export interface SceneService {
  /** 登记节点世界矩形；节点卸载时 dispose */
  register(nodeId: string, rect: Rect): Disposable
  /** 单个节点包围盒 */
  getBounds(nodeId: string): Rect | undefined
  /** 多个节点的联合包围盒；无命中返回 undefined */
  getBoundsOf(ids: readonly string[]): Rect | undefined
  /** 文档根尺寸 */
  getRootSize(): Size
  /** 文档世界包围盒；fit 使用 */
  getRootBounds(): Rect
  /** 失效测量缓存；schema 变化时调用 */
  invalidate(nodeIds?: readonly string[]): void
  /** 当前登记顺序（底 → 顶） */
  list(): readonly string[]
  /** 几何变化通知 */
  onDidChange(listener: () => void): Disposable
}

/** 命中测试服务 */
export interface HitTestService {
  /** 命中屏幕点下最深的节点；忽略覆盖层 */
  at(screen: Point): string | undefined
  /** 命中矩形内的节点；框选使用 */
  inRect(screenRect: Rect): string[]
  /** 命中容器节点，用于拖入判定 */
  containerAt(screen: Point): string | undefined
}

/** 尺寸测量服务 */
export interface MeasureService {
  /** 节点世界矩形 */
  measure(nodeId: string): Rect | undefined
  /** 批量测量 */
  measureMany(ids: readonly string[]): Map<string, Rect>
}

/** 交互处理器注册 */
export interface CanvasInteractionService {
  /** 注册交互处理器；id 冲突时报错 */
  register<E extends CanvasInputEvent>(handler: InteractionHandler<E>): Disposable
  /** 当前处理器，调试用 */
  list(): readonly InteractionHandler[]
  /**
   * 声明当前处理器接管后续 move/up。
   *
   * 返回的 Disposable 用于提前结束手势（如 pointerup 后主动释放）。
   */
  beginGesture(callbacks: GestureCallbacks): Disposable
}

/** 覆盖层注册 */
export interface CanvasLayerService {
  /** 注册覆盖层；band + zIndex 决定顺序 */
  register(layer: CanvasLayer): Disposable
  /** 当前图层，调试用 */
  list(): readonly CanvasLayer[]
  /** 图层集合变化通知 */
  onDidChange(listener: () => void): Disposable
}

/** 画布手势事务 */
export interface CanvasTransaction {
  /** 预览 patch；不写历史、不标脏文档 */
  preview(patches: readonly SchemaPatch[]): void
  /** 提交；写入文档并产生一条历史 */
  commit(): void
  /** 取消；恢复到手势前状态 */
  cancel(): void
  /** 是否已结束 */
  readonly closed: boolean
}

/** 事务服务；同一时刻只允许一个活动事务 */
export interface TransactionService {
  /**
   * 开始一次手势事务。
   *
   * @throws 已有活动事务时抛错；抢不到事务的插件应放弃本次手势。
   */
  begin(options: { label: string; owner: string }): CanvasTransaction
}

/** 画布设置服务 */
export interface CanvasSettingsService {
  /** 注册设置项；scope 决定持久化层级 */
  register<T>(setting: CanvasSetting<T>): Disposable
  /** 读取合并后的值；未注册时返回 undefined */
  get<T>(id: string): T | undefined
  /** 修改当前 scope 的值；受策略锁定时抛错 */
  set<T>(id: string, value: T): void
  /** 订阅变化；插件卸载自动移除 */
  onDidChange(id: string, listener: (value: unknown) => void): Disposable
}

/** rAF 调度服务 */
export interface SchedulerService {
  /** 标记视口脏；下一帧通知宿主更新内容 transform */
  invalidateViewport(): void
  /** 标记某个覆盖层脏 */
  invalidateLayer(id: string): void
  /** 下一帧执行；返回取消函数 */
  nextFrame(task: () => void): Disposable
  /** 每帧回调；宿主用它批量提交 DOM 写入 */
  onFrame(listener: () => void): Disposable
}

/** 吸附服务；由 canvas-snap 插件提供，不属于 CanvasService */
export interface SnapService {
  /** 是否启用吸附；由设置/快捷键控制 */
  enabled: boolean
  /** 阈值以屏幕像素表示，内部按 zoom 换算，保证手感一致 */
  thresholdScreenPx: number
  /** 注册候选提供者 */
  registerProvider(provider: SnapProvider): Disposable
  /** 解析一组移动中的矩形/点，返回吸附结果与辅助线 */
  resolve(input: SnapInput): SnapResult
  /** 最近一次解析结果；覆盖层读取它绘制辅助线 */
  readonly lastResult: SnapResult | null
  /** 解析结果变化通知 */
  onDidChange(listener: () => void): Disposable
}

/**
 * 画布服务：画布微内核的唯一入口。
 *
 * 画布插件只依赖这里；snap 是独立服务，通过 `ctx.get('snap')` 可选获取。
 */
export interface CanvasService {
  /** 视口状态与坐标变换 */
  readonly viewport: ViewportService
  /** 场景图与几何 */
  readonly scene: SceneService
  /** 命中测试 */
  readonly hitTest: HitTestService
  /** 尺寸测量 */
  readonly measure: MeasureService
  /** 选中集（与 EditorContext.selection 为同一实例） */
  readonly selection: SelectionService
  /** 交互处理器注册 */
  readonly interaction: CanvasInteractionService
  /** 覆盖层注册 */
  readonly layers: CanvasLayerService
  /** 手势事务 */
  readonly transaction: TransactionService
  /** 画布设置 */
  readonly settings: CanvasSettingsService
  /** rAF 调度 */
  readonly scheduler: SchedulerService
  /**
   * 隐藏 / 锁定集合（含沿树继承的结果），随文档变化整体刷新。
   *
   * 覆盖层的 `visible` 每帧都会求值，这里给的是已算好的只读集合，查一次 O(1)；
   * 手势起始处的批量过滤用 `transformableIds`，那里还需要顺带剔除文档里已不存在的 id。
   */
  readonly nodeFlags: NodeFlagView
  /**
   * 挂载舞台 DOM：指针/滚轮/键盘管线在此生效。
   *
   * 由 CanvasStage 调用；同一画布只允许一个舞台。返回的 Disposable
   * 解绑全部监听并清空视口尺寸。
   */
  attach(element: HTMLElement): Disposable
}
