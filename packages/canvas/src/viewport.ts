import type { Disposable } from '@lc/kernel'
import type { Matrix2D, Point, Rect, Size, ViewportService, ViewportState } from '@lc/contracts'
import { clamp } from '@lc/shared'

/** 视口创建选项 */
export interface CreateViewportOptions {
  /**
   * 最小缩放 @default 0.1
   *
   * 只在建实例时读取一次，之后无法通过服务修改；所有写入路径
   * （`set` / `zoomAt` / `fit`）都会把 zoom 收敛到 [minZoom, maxZoom]，
   * 越界值静默夹紧而不抛错。
   */
  minZoom?: number

  /**
   * 最大缩放 @default 4
   *
   * 必须不小于 minZoom：`clamp` 在 min > max 时直接抛错，而构造阶段就会
   * 用它夹紧 initial.zoom。
   */
  maxZoom?: number

  /**
   * 初始状态；缺省 origin(0,0)、zoom 1、rotation 0
   *
   * 这里传入的 zoom 同样会被夹紧，因此可以安全地用作持久化视口的恢复值；
   * 恢复出来的字段不是有限数时按缺省值处理，而不是让坏数据进入画面。
   * rotation 单位为弧度且不限制取值范围，调用方需要自己保证与覆盖层一致。
   */
  initial?: Partial<ViewportState>

  /**
   * 初始可视区尺寸 @default { width: 0, height: 0 }
   *
   * 未测量前尺寸为 0，此时 `fit` 会直接返回而不改变缩放；实际尺寸由
   * `canvas.attach(element)` 里的 ResizeObserver 写入。负值与非有限值都收敛为 0。
   */
  size?: Size
}

/** 未指定 minZoom / maxZoom 时的缩放下限与上限，二者共同界定 zoomAt 的可用区间 */
const DEFAULT_MIN_ZOOM = 0.1
const DEFAULT_MAX_ZOOM = 4

/**
 * 非有限值回退：NaN / Infinity 一律沿用当前值。
 *
 * 坏值通常来自上游的一次除零或量到零尺寸容器。`clamp` 会把 NaN 原样透传，
 * 而 NaN 一旦进入 state，矩阵就变成 `matrix(NaN, …)`，CSS 直接丢弃整条 transform：
 * 画面整体消失、指针换算全部失真，且不抛任何错误，几乎无法定位。
 */
function finiteOr(value: number, current: number): number {
  return Number.isFinite(value) ? value : current
}

/**
 * 把屏幕空间的向量换算成世界空间的增量：先逆旋转、再除以缩放。
 *
 * `screenToWorld` / `zoomAt` / `panBy` / `fit` 共用这一条逆变换。四处各自展开
 * cos/sin 时，任一处符号写反都会在旋转视口下产生系统性偏移，所以只保留一份
 * 闭式实现。这里处理的是「差值 / 位移」，不含 origin 平移，由调用方自行加减。
 *
 * 保持纯计算：不读 state，cos / sin 由调用方一次算好后传入，
 * pointermove 高频路径上每帧只调用一次三角函数。
 *
 * @param vector 屏幕空间向量（CSS 像素）
 * @param cos 当前视口旋转的余弦
 * @param sin 当前视口旋转的正弦
 * @param zoom 目标缩放，必须为正数
 * @returns 世界坐标增量（画布逻辑单位）
 */
function screenVectorToWorld(vector: Point, cos: number, sin: number, zoom: number): Point {
  return {
    x: (cos * vector.x + sin * vector.y) / zoom,
    y: (-sin * vector.x + cos * vector.y) / zoom,
  }
}

/**
 * 完整容纳 rect 所需的缩放：宽、高两个比例取小者后夹紧到上下限。
 *
 * 可用宽高下限取 1 而不是直接用 `size - padding * 2`：padding 大于视口时该值
 * 为负或 0，除法会得到负缩放或 Infinity，画面会翻转或直接消失。
 * 夹紧生效时画面会留白或被裁切，不保证一定看得见整个 rect。
 */
function fitZoom(
  size: Size,
  rect: Rect,
  padding: number,
  minZoom: number,
  maxZoom: number,
): number {
  const availableWidth = Math.max(size.width - padding * 2, 1)
  const availableHeight = Math.max(size.height - padding * 2, 1)

  return clamp(
    Math.min(availableWidth / rect.width, availableHeight / rect.height),
    minZoom,
    maxZoom,
  )
}

/**
 * 创建视口服务。
 *
 * 变换顺序固定为 `screen = S(zoom) · R(rotation) · (world - origin)`：
 * 先平移到原点、再旋转、最后缩放。所有插件只能通过本服务换算坐标，
 * 不得自行拼接矩阵，否则旋转视口后手柄/吸附会出现系统性偏移。
 */
export function createViewport(options: CreateViewportOptions = {}): ViewportService {
  const minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM
  const maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM

  let state: ViewportState = {
    x: finiteOr(options.initial?.x ?? 0, 0),
    y: finiteOr(options.initial?.y ?? 0, 0),
    zoom: clamp(finiteOr(options.initial?.zoom ?? 1, 1), minZoom, maxZoom),
    rotation: finiteOr(options.initial?.rotation ?? 0, 0),
  }
  let size: Size = {
    width: Math.max(0, finiteOr(options.size?.width ?? 0, 0)),
    height: Math.max(0, finiteOr(options.size?.height ?? 0, 0)),
  }
  let matrix: Matrix2D = computeMatrix(state)
  const listeners = new Set<() => void>()

  /**
   * 唯一的视口写入出口：夹紧 zoom、按需重算矩阵、按需通知。
   *
   * state 每次都会被替换，但只有 zoom/x/y/rotation 或尺寸真正变化时才重算
   * 矩阵并通知监听；因此传入越界 zoom 不会触发额外一轮覆盖层刷新。
   * 覆盖层与状态栏都依赖这条通知链，任何绕过 commit 的赋值都会让矩阵与
   * state 失同步。
   *
   * 坏值按「本次不写」处理而不是抛错：视口是渲染状态，一次 NaN 不该让整条
   * 指针手势和已正常的画面一起废掉。
   */
  function commit(next: ViewportState, nextSize?: Size): void {
    const zoom = clamp(finiteOr(next.zoom, state.zoom), minZoom, maxZoom)
    const x = finiteOr(next.x, state.x)
    const y = finiteOr(next.y, state.y)
    const rotation = finiteOr(next.rotation, state.rotation)
    // 尺寸坏值按「未测量」处理成 0，与 ResizeObserver 拿不到盒子时的表达保持一致
    const resolvedSize = nextSize
      ? {
          width: Math.max(0, finiteOr(nextSize.width, size.width)),
          height: Math.max(0, finiteOr(nextSize.height, size.height)),
        }
      : undefined

    const changed =
      zoom !== state.zoom ||
      x !== state.x ||
      y !== state.y ||
      rotation !== state.rotation ||
      (resolvedSize !== undefined &&
        (resolvedSize.width !== size.width || resolvedSize.height !== size.height))

    state = { x, y, zoom, rotation }
    if (resolvedSize) size = resolvedSize
    if (!changed) return

    matrix = computeMatrix(state)
    for (const listener of [...listeners]) listener()
  }

  /** 部分更新：省略的字段沿用当前值，无法借此把某个字段重置为默认值。 */
  function commitPartial(patch: Partial<ViewportState>): void {
    commit({
      x: patch.x ?? state.x,
      y: patch.y ?? state.y,
      zoom: patch.zoom ?? state.zoom,
      rotation: patch.rotation ?? state.rotation,
    })
  }

  const service: ViewportService = {
    get state() {
      return state
    },

    get matrix() {
      return matrix
    },

    get size() {
      return size
    },

    get center() {
      // 尺寸尚未测得（0×0）时结果为 origin 自身，宿主不应据此 fit
      return service.screenToWorld({ x: size.width / 2, y: size.height / 2 })
    },

    // 以下两个换算走闭式公式而不复用 matrix：单点换算不必构造矩阵，
    // pointermove 高频路径上可避免每次分配新元组。
    screenToWorld(point) {
      const cos = Math.cos(state.rotation)
      const sin = Math.sin(state.rotation)
      const offset = screenVectorToWorld(point, cos, sin, state.zoom)
      return { x: state.x + offset.x, y: state.y + offset.y }
    },

    worldToScreen(point) {
      const cos = Math.cos(state.rotation)
      const sin = Math.sin(state.rotation)
      const dx = point.x - state.x
      const dy = point.y - state.y
      return {
        x: (cos * dx - sin * dy) * state.zoom,
        y: (sin * dx + cos * dy) * state.zoom,
      }
    },

    /**
     * 围绕屏幕点缩放。
     *
     * factor 是倍率而非目标缩放值，连续滚轮因此可复合；夹紧后 zoom 未变时
     * 直接返回，origin 不会被重新计算，避免已到上下限时画面仍然漂移。
     *
     * @param screen 保持不动的屏幕点，通常是指针位置
     * @param factor 新 zoom = 当前 zoom × factor
     */
    zoomAt(screen, factor) {
      const nextZoom = clamp(state.zoom * factor, minZoom, maxZoom)
      if (nextZoom === state.zoom) return

      const cos = Math.cos(state.rotation)
      const sin = Math.sin(state.rotation)
      // 保持指针下的世界坐标不动：origin' = world - 新缩放下的屏幕逆变换
      const world = service.screenToWorld(screen)
      const anchor = screenVectorToWorld(screen, cos, sin, nextZoom)
      commit({
        x: world.x - anchor.x,
        y: world.y - anchor.y,
        zoom: nextZoom,
        rotation: state.rotation,
      })
    },

    /**
     * 按屏幕位移平移视口。
     *
     * 位移先经逆旋转再除以 zoom：origin 与世界坐标同向，而画面移动方向相反，
     * 因此这里整体取负。delta 始终是屏幕像素，传世界坐标会双重缩放。
     */
    panBy(delta) {
      const cos = Math.cos(state.rotation)
      const sin = Math.sin(state.rotation)
      const move = screenVectorToWorld(delta, cos, sin, state.zoom)
      commit({
        x: state.x - move.x,
        y: state.y - move.y,
        zoom: state.zoom,
        rotation: state.rotation,
      })
    },

    /**
     * 缩放到完整容纳一个世界矩形，并把它摆到视口中心。
     *
     * 缩放取值见 `fitZoom`；矩形尺寸按未旋转的轴算，视口处于旋转状态时只保证中心
     * 对齐，不保证视觉上完整包含。
     *
     * 视口尺寸尚未测得（width / height 为 0）时静默返回，此时应先 `setSize`；
     * 矩形宽高为非有限值时同样静默返回，否则 NaN 会顺着 zoom 落进矩阵。
     *
     * @param rect 需要容纳的世界坐标矩形（画布逻辑单位，非屏幕像素）
     * @param padding 每边留白，单位屏幕 CSS 像素；未传时按 40 计算
     */
    fit(rect, padding = 40) {
      // NaN 过不了 `<= 0` 这道判断，却会把 NaN 带进 zoom 与中心点，所以先拒掉
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return
      if (rect.width <= 0 || rect.height <= 0) return
      if (size.width <= 0 || size.height <= 0) return

      const zoom = fitZoom(size, rect, padding, minZoom, maxZoom)
      const centerWorld = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }

      // origin 为 0 时屏幕中心对应的世界偏移，用矩形中心减掉它就把它落到了屏幕中心
      const cos = Math.cos(state.rotation)
      const sin = Math.sin(state.rotation)
      const offset = screenVectorToWorld(
        { x: size.width / 2, y: size.height / 2 },
        cos,
        sin,
        zoom,
      )

      commit({
        x: centerWorld.x - offset.x,
        y: centerWorld.y - offset.y,
        zoom,
        rotation: state.rotation,
      })
    },

    set(next) {
      commitPartial(next)
    },

    setSize(next) {
      // 夹紧与非有限值兜底都发生在 commit 里，这里不再重复一套尺寸规则
      commit(state, next)
    },

    onDidChange(listener): Disposable {
      // listeners 是 Set：同一函数重复注册只保留一份，任一 Disposable 释放即全部失效
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }

  return service
}

/**
 * 生成 world → screen 矩阵，元素顺序与 CSS `matrix(a, b, c, d, e, f)` 一致。
 *
 * 渲染层把它原样写进 transform，所以这里的推导必须与 `worldToScreen` 的
 * 闭式公式逐项对应；两者不一致时画面与坐标换算会分裂成两套结果。
 */
function computeMatrix(state: ViewportState): Matrix2D {
  const cos = Math.cos(state.rotation)
  const sin = Math.sin(state.rotation)
  const { zoom, x, y } = state
  return [
    zoom * cos,
    zoom * sin,
    -zoom * sin,
    zoom * cos,
    -zoom * (cos * x - sin * y),
    -zoom * (sin * x + cos * y),
  ]
}
