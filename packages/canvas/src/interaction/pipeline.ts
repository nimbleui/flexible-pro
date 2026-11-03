import type { Diagnostics, Disposable } from '@lc/kernel'
import type {
  CanvasContext,
  CanvasInputEvent,
  CanvasInteractionService,
  CanvasKeyboardEvent,
  CanvasModifiers,
  CanvasPointerEvent,
  GestureCallbacks,
  HitTestService,
  InteractionHandler,
  InteractionResult,
  Point,
  PointerPhase,
  ViewportService,
} from '@lc/contracts'
import { isPointerEvent } from '@lc/contracts'

/** 交互管线创建选项 */
export interface CreateInteractionOptions {
  /** 视口换算（screen ↔ world）；每个指针事件都经它补 world 字段，处理器不需要再自行换算 */
  viewport: ViewportService

  /** 命中测试；只在 pointerdown 解析一次目标，后续事件复用按下时的命中结果 */
  hitTest: HitTestService

  /** 诊断上报（处理器异常隔离）；处理器与手势回调抛出的异常都会转成 report，不会向上冒泡 */
  diagnostics: Diagnostics

  /**
   * 取得画布上下文；处理器运行时 canvas 服务已就绪
   *
   * 采用惰性取值而不是直接传 ctx：管线在 canvas 服务自身构造期间就被创建，
   * 此刻 ctx 尚未 provide 完成，事件真正发生时才可以安全读取。
   */
  getContext: () => CanvasContext

  /**
   * 点击与拖拽的位移阈值（屏幕像素） @default 3
   *
   * pointerdown 与 pointerup 的位移不超过该值才合成 click 事件；只影响 click
   * 判定，不改变处理器看到的 delta。取值只在建管线时读取一次。
   */
  dragThresholdPx?: number
}

/** 交互管线：契约服务 + 舞台挂载 */
export interface InteractionPipeline extends CanvasInteractionService {
  /**
   * 挂载舞台 DOM：注册唯一一套根监听器。
   *
   * @returns 解绑函数；会结束未完成手势并释放 pointer capture。
   */
  attach(element: HTMLElement): Disposable
}

/** pointerdown 到 pointerup 之间判定为点击而非拖拽的最大屏幕位移 */
const DEFAULT_DRAG_THRESHOLD = 3

/**
 * `InteractionHandler` 抹掉事件泛型后的内部形态。
 *
 * 管线只在运行时按事件实际类型分发，注册期无法为每个 handler 保留 E，
 * 因此统一收窄成 CanvasInputEvent，由处理器自行用类型守卫判断。
 */
type AnyHandler = {
  /** 处理器全局唯一 id，冲突时在 register 抛错 */
  id: string

  /** 分发阶段；注册时已补默认值，内部不再判空 */
  phase: PointerPhase

  /** 同阶段内越大越先执行；已补默认值 0 */
  priority: number

  /** 注册序号，phase 与 priority 都相同时用它保证先到先得 */
  seq: number

  /** 准入谓词；每轮分发对每个阶段都会调用，注册时已包一层类型收窄 */
  when?: (event: CanvasInputEvent, ctx: CanvasContext) => boolean

  /** 实际处理函数；返回值决定是否中止后续分发 */
  handle: (event: CanvasInputEvent, ctx: CanvasContext) => InteractionResult
}

/**
 * 舞台本地屏幕坐标。
 *
 * 单位是 CSS 像素，原点在舞台 `getBoundingClientRect()` 的左上角（已减掉 rect
 * 偏移），不是 clientX / clientY；数值不含视口 zoom 与 origin 平移，
 * 世界坐标一律用 `Point` 表示。
 */
type ScreenPoint = {
  /** 水平方向，向右为正 */
  x: number

  /** 垂直方向，向下为正（屏幕 y 轴朝下，与世界 y 轴同向） */
  y: number
}

/**
 * 相邻两次指针事件的屏幕位移。
 *
 * 与 `ScreenPoint` 同一坐标空间（舞台本地 CSS 像素），可为负；指针首次入场、
 * `click` 等合成事件按约定给 0，不表示「没有移动过」。
 */
type ScreenDelta = ScreenPoint

/**
 * pointerdown 解析出的命中信息。
 *
 * 一次按下只解析一次，后续 move / up / click 全部复用它，指针滑出原节点不会改判目标。
 */
interface DownHit {
  /** 命中的场景节点 id；命中覆盖层手柄或空白处时为 undefined */
  targetNodeId?: string

  /** 命中的覆盖层手柄 id（取自最近的 `[data-handle-id]` 属性值）；非手柄时为 undefined */
  targetHandleId?: string
}

/** 按下时的完整基准：命中信息 + 按下点，抬手时据此判定这一次算拖拽还是点击 */
interface DownState extends DownHit {
  /** 按下点的屏幕坐标（舞台本地 CSS 像素），与抬手点求欧氏距离后与阈值比较 */
  screen: ScreenPoint
}

/** 一次指针事件的坐标对，构造事件时整体展开，保证两个值同源 */
interface EventCoords {
  /** 舞台本地屏幕坐标（CSS 像素，原点为舞台 rect 左上角） */
  screen: ScreenPoint

  /** screen 经视口换算得到的世界坐标（画布逻辑单位） */
  world: Point
}

/** 构造 CanvasPointerEvent 所需的入参，缺省字段由管线补齐 */
interface PointerInit {
  /** 对外暴露的事件类型，与原生事件名不一定同名（click 由管线合成） */
  type: CanvasPointerEvent['type']

  /** 舞台本地屏幕坐标（CSS 像素，原点为舞台 rect 左上角），不是 clientX / clientY */
  screen: ScreenPoint

  /** screen 经 `viewport.screenToWorld` 换算的世界坐标（画布逻辑单位，含 origin 平移、已除 zoom） */
  world: Point

  /** 相对上一次指针事件的屏幕位移（舞台本地 CSS 像素）；首个事件与合成事件均为 0 */
  delta: ScreenDelta

  /** 原生 buttons 快照；非指针来源的合成事件按调用处给定值透传 */
  buttons: number

  /** 原生 pointerId；键盘与非指针来源事件没有真实指针时传 -1 */
  pointerId: number

  /** 按下时解析到的节点；手柄命中时为 undefined */
  targetNodeId?: string

  /** 按下时命中的覆盖层手柄 id，决定 target 阶段是否进入 */
  targetHandleId?: string

  /** 原始 DOM 事件；preventDefault / stopPropagation 都转发到它 */
  originalEvent: PointerEvent | WheelEvent | MouseEvent
}

/** 分发顺序：先捕获、再手柄目标阶段、最后冒泡，与 DOM 事件模型保持同一心智 */
const PHASE_ORDER: readonly PointerPhase[] = ['capture', 'target', 'bubble']

/**
 * 创建交互管线。
 *
 * 分发规则（骨架实现）：
 * 1. 只有一个根 pointerdown 监听器，命中后 `setPointerCapture`；
 * 2. 处理器按 phase（capture → target → bubble）+ priority 降序执行；
 * 3. `target` 阶段仅在命中手柄（`data-handle-id`）时进入，保证手柄优先；
 * 4. `handled` 视为跨阶段消费（比文档的「同阶段消费」更严格），
 *    让「缩放手柄 vs 节点拖拽」这类冲突结果可预测；
 * 5. 单处理器异常只上报诊断，不阻断后续处理器。
 */
export function createInteractionPipeline(
  options: CreateInteractionOptions,
): InteractionPipeline {
  const threshold = options.dragThresholdPx ?? DEFAULT_DRAG_THRESHOLD

  /** 注册顺序数组；排序只在分发时产生副本，注册本身不维持有序 */
  const handlers: AnyHandler[] = []

  /** 调用过 stopPropagation 的事件；WeakSet 让事件对象随原生事件一起回收 */
  const stoppedEvents = new WeakSet<CanvasInputEvent>()

  let seq = 0

  /** 当前挂载的舞台元素；null 表示未 attach，此时不产生任何事件 */
  let stage: HTMLElement | null = null

  /** 舞台 rect 快照：指针事件里只读缓存，避免每次 move 触发一次布局读取 */
  let stageRect: DOMRect | null = null

  /**
   * 上一次指针事件的屏幕坐标，用于算 delta。
   *
   * null 表示「没有前一次可比的位置」：尚未收到过指针事件、pointerleave 之后，
   * 或 attach 解绑重来；此时第一个 move 的 delta 记 0，而不是拿更早的按下点当基准。
   */
  let lastScreen: ScreenPoint | null = null

  /**
   * 本次按下的起点与命中信息。
   *
   * pointermove / pointerup 复用它的命中结果，指针移出原节点不会改判目标；
   * pointerup 收尾与 pointercancel、解绑时置 null。
   */
  let down: DownState | null = null

  /** 当前接管手势的回调；非空时 pointermove / pointerup 不再走普通分发 */
  let gesture: GestureCallbacks | null = null

  /** 已捕获的 pointerId，用于卸载时精确释放捕获 */
  let activePointerId: number | null = null

  /** 重新测量舞台 rect；只在按下、滚轮、右键、窗口尺寸变化时调用 */
  function updateStageRect(): void {
    if (stage) stageRect = stage.getBoundingClientRect()
  }

  /**
   * 把 clientX/clientY 换算成舞台本地屏幕坐标。
   *
   * rect 尚未测量时按 0 偏移处理，结果等价于 client 坐标；舞台滚动或缩放后
   * 必须先 `updateStageRect`，否则整条手势会带上固定偏移。
   */
  function toScreen(native: MouseEvent): ScreenPoint {
    const rect = stageRect
    return {
      x: native.clientX - (rect?.left ?? 0),
      y: native.clientY - (rect?.top ?? 0),
    }
  }

  /**
   * 一次性产出 screen + world 两个事件字段。
   *
   * 滚轮 / 右键 / 双击此前各调用两次 `toScreen` 再各自换算一次，合并后既省掉重复
   * 换算，也保证 screen 与 world 来自同一次 rect 快照。
   */
  function coordsOf(native: MouseEvent): EventCoords {
    const screen = toScreen(native)
    return { screen, world: options.viewport.screenToWorld(screen) }
  }

  /** 取修饰键快照；处理器读到的是事件发生瞬间的按键状态，不会在异步逻辑里变化 */
  function modifiersOf(native: MouseEvent | KeyboardEvent): CanvasModifiers {
    return {
      alt: native.altKey,
      ctrl: native.ctrlKey,
      meta: native.metaKey,
      shift: native.shiftKey,
    }
  }

  /**
   * 组装对外的指针事件。
   *
   * phase 先占位 bubble，由 `dispatch` 在每个阶段覆写同一个对象：处理器读到的是
   * 当前阶段，但事件引用全程唯一，`stoppedEvents` 与原生事件才能对得上。
   * stopPropagation 除了调用原生方法，还额外记入 stoppedEvents——原生停止传播
   * 拦不住同一元素上由管线自己逐个调用的处理器。
   */
  function createPointerEvent(init: PointerInit): CanvasPointerEvent {
    const event: CanvasPointerEvent = {
      type: init.type,
      phase: 'bubble',
      modifiers: modifiersOf(init.originalEvent),
      screen: init.screen,
      world: init.world,
      delta: init.delta,
      buttons: init.buttons,
      pointerId: init.pointerId,
      targetNodeId: init.targetNodeId,
      targetHandleId: init.targetHandleId,
      originalEvent: init.originalEvent,
      preventDefault: () => init.originalEvent.preventDefault(),
      stopPropagation: () => {
        stoppedEvents.add(event)
        init.originalEvent.stopPropagation()
      },
    }
    return event
  }

  /**
   * 组装对外的键盘事件。
   *
   * 与 `createPointerEvent` 同一套 phase / stopPropagation 约定；键盘事件不是
   * 指针事件，`dispatch` 会跳过 target 阶段，手柄处理器收不到按键。
   */
  function createKeyboardEvent(
    type: 'keydown' | 'keyup',
    native: KeyboardEvent,
  ): CanvasKeyboardEvent {
    const event: CanvasKeyboardEvent = {
      type,
      phase: 'bubble',
      modifiers: modifiersOf(native),
      key: native.key,
      code: native.code,
      repeat: native.repeat,
      originalEvent: native,
      preventDefault: () => native.preventDefault(),
      stopPropagation: () => {
        stoppedEvents.add(event)
        native.stopPropagation()
      },
    }
    return event
  }

  /**
   * 按 phase → priority 降序 → 注册顺序排出分发序列。
   *
   * 每次调用重新排序并返回副本，而不维护有序数组：处理器数量有限，注册与注销
   * 不必承担插入成本。分发按阶段各取一次快照，因此处理器在自身回调里注销别人，
   * 只影响它之后的阶段，同一阶段内的本轮遍历不受影响。
   */
  function sortedHandlers(): AnyHandler[] {
    return [...handlers].sort((a, b) => {
      const phaseDiff = PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase)
      if (phaseDiff !== 0) return phaseDiff
      const priorityDiff = b.priority - a.priority
      if (priorityDiff !== 0) return priorityDiff
      return a.seq - b.seq
    })
  }

  /**
   * 依次走完三个阶段，返回事件是否被消费。
   *
   * 消费条件有三种：处理器返回 `stop` 或 `handled`、处理器调用过
   * `stopPropagation`。其中 `handled` 会终止整个分发而不只结束当前阶段，
   * 这是「手柄优先于节点拖拽」能够预测的前提。
   * `when` 与 `handle` 都在 try 内：一个处理器抛错只损失它自己，后续处理器
   * 与阶段照常执行。
   */
  function dispatch(event: CanvasInputEvent): boolean {
    const ctx = options.getContext()

    for (const phase of PHASE_ORDER) {
      // 只有命中覆盖层手柄时才进入 target 阶段，否则手柄插件会抢走普通节点手势
      if (phase === 'target' && (!isPointerEvent(event) || !event.targetHandleId)) continue

      for (const handler of sortedHandlers()) {
        if (handler.phase !== phase) continue

        event.phase = phase
        try {
          if (handler.when && !handler.when(event, ctx)) continue
          const result = handler.handle(event, ctx)
          if (result === 'stop') return true
          if (result === 'handled' || stoppedEvents.has(event)) return true
        } catch (error) {
          options.diagnostics.report(error, {
            scope: 'interaction',
            handlerId: handler.id,
          })
        }
      }
    }
    return false
  }

  /**
   * 解析按下目标的命中信息。
   *
   * 手柄优先：沿 DOM 向上找到最近的 `[data-handle-id]`，命中手柄时不再给
   * targetNodeId，节点级处理器因此不会与手柄抢同一次按下。手柄由覆盖层渲染，
   * 不在场景登记中，无需额外的图层过滤。
   */
  function resolveTarget(native: MouseEvent, screen: ScreenPoint): DownHit {
    const target = native.target
    const handleElement = target instanceof Element ? target.closest('[data-handle-id]') : null
    const targetHandleId = handleElement?.getAttribute('data-handle-id') ?? undefined
    const targetNodeId = targetHandleId ? undefined : options.hitTest.at(screen)
    return { targetNodeId, targetHandleId }
  }

  /**
   * 收尾当前手势。
   *
   * 先把 gesture 置空再回调：onFinish 里常常紧接着 beginGesture，若先回调
   * 会被旧手势以「已存在活动手势」挡掉。无手势时是空操作，所以 pointerup、
   * Escape、pointercancel 与卸载都无条件调用它。异常只上报，不影响状态清理。
   */
  function finishGesture(commit: boolean): void {
    const current = gesture
    gesture = null
    if (!current) return
    try {
      current.onFinish(commit)
    } catch (error) {
      options.diagnostics.report(error, { scope: 'gesture', handler: 'onFinish' })
    }
  }

  /**
   * 释放指针捕获并清空 activePointerId。
   *
   * 捕获不释放会让浏览器继续把事件路由到已卸载的舞台；指针已消失时
   * hasPointerCapture / releasePointerCapture 会抛错，这里吞掉异常以保证
   * 手势收尾不被 DOM 状态影响。
   */
  function releaseCapture(): void {
    if (stage && activePointerId !== null) {
      try {
        if (stage.hasPointerCapture(activePointerId))
          stage.releasePointerCapture(activePointerId)
      } catch {
        // 指针已失效时忽略；不应影响手势收尾
      }
    }
    activePointerId = null
  }

  const service: InteractionPipeline = {
    /**
     * 注册交互处理器。
     *
     * phase / priority 在此补默认值，注册后改对象上的字段不会影响已入队的排序。
     *
     * @throws 处理器 id 重复时抛错。
     */
    register<E extends CanvasInputEvent>(handler: InteractionHandler<E>): Disposable {
      if (handlers.some((item) => item.id === handler.id)) {
        throw new Error(`[canvas] 交互处理器 id 重复: ${handler.id}`)
      }

      // 注册时抹平函数参数逆变：管线按事件的运行时类型分发，处理器自行用
      // isPointerEvent / 事件类型字段收窄。
      const when = handler.when
      const entry: AnyHandler = {
        id: handler.id,
        phase: handler.phase ?? 'bubble',
        priority: handler.priority ?? 0,
        seq: ++seq,
        when: when ? (event, ctx) => when(event as E, ctx) : undefined,
        handle: (event, ctx) => handler.handle(event as E, ctx),
      }
      handlers.push(entry)

      return {
        dispose: () => {
          const index = handlers.indexOf(entry)
          if (index >= 0) handlers.splice(index, 1)
        },
      }
    },

    list() {
      // 返回排序后的内部形态（phase / priority 已补默认值），仅供调试面板使用
      return sortedHandlers() as readonly InteractionHandler[]
    },

    /**
     * 声明当前处理器接管后续 move / up。
     *
     * 接管期间 pointermove 与 pointerup 只走手势回调，不再进入普通分发；
     * pointerdown 本身仍会正常分发，处理器是在 handle 里调用本方法的。
     *
     * @throws 已有活动手势时抛错，一个舞台同时只允许一条手势链。
     */
    beginGesture(callbacks): Disposable {
      if (gesture) throw new Error('[canvas] 已存在活动手势')
      gesture = callbacks
      return {
        dispose: () => {
          // 比对回调引用：手势已被 pointerup 结束时，迟到的 dispose 不应再回调一次 onFinish
          if (gesture === callbacks) finishGesture(false)
        },
      }
    },

    /**
     * 挂载舞台 DOM。
     *
     * 一个管线实例同一时刻只应挂一个舞台：stage / stageRect 等状态是单例的，
     * 重复 attach 会覆盖前一个舞台，而前一套监听器仍在其上直到旧 Disposable 执行。
     *
     * element 需要 `tabindex`，否则 keydown / keyup 收不到键盘事件；wheel 以
     * `passive: false` 注册，缩放插件才可能 preventDefault 阻止页面滚动。
     * 位移超过阈值的 pointerup 不再合成 click，与浏览器原生行为一致。
     */
    attach(element): Disposable {
      stage = element
      updateStageRect()

      const onPointerDown = (native: PointerEvent): void => {
        // 每次按下重新测量：舞台位置可能在两次按下之间变化
        updateStageRect()
        const { screen, world } = coordsOf(native)
        lastScreen = screen

        // 捕获后 move/up 全部回到舞台，指针滑出画布也不会丢手势；
        // 捕获失败（指针已释放）时置空 id，收尾路径照常走普通监听
        if (stage) {
          try {
            stage.setPointerCapture(native.pointerId)
            activePointerId = native.pointerId
          } catch {
            activePointerId = null
          }
        }

        const target = resolveTarget(native, screen)
        down = { screen, ...target }

        dispatch(
          createPointerEvent({
            type: 'pointerdown',
            screen,
            world,
            delta: { x: 0, y: 0 },
            buttons: native.buttons,
            pointerId: native.pointerId,
            ...target,
            originalEvent: native,
          }),
        )
      }

      /**
       * 抬手位移在阈值内时补发合成 click。
       *
       * click 的 delta 恒为 0（合成事件没有「上一次指针位置」），命中信息沿用按下时的
       * down，与同一次 pointerup 保持一致；超过阈值即视为拖拽，不再补 click。
       */
      const dispatchTap = (native: PointerEvent, screen: ScreenPoint, world: Point): void => {
        if (!down || distance(down.screen, screen) > threshold) return

        dispatch(
          createPointerEvent({
            type: 'click',
            screen,
            world,
            delta: { x: 0, y: 0 },
            buttons: native.buttons,
            pointerId: native.pointerId,
            ...downTarget(down),
            originalEvent: native,
          }),
        )
      }

      const onPointerMove = (native: PointerEvent): void => {
        const { screen, world } = coordsOf(native)
        const delta = deltaFrom(lastScreen, screen)
        lastScreen = screen

        const event = createPointerEvent({
          type: 'pointermove',
          screen,
          world,
          delta,
          buttons: native.buttons,
          pointerId: native.pointerId,
          ...downTarget(down),
          originalEvent: native,
        })

        // 手势接管时只喂给 onMove，不再进入普通分发；事件仍完整构造，
        // 保证处理器能拿到同一份 world / delta / 命中信息
        if (gesture) {
          try {
            gesture.onMove(event)
          } catch (error) {
            options.diagnostics.report(error, { scope: 'gesture', handler: 'onMove' })
          }
          return
        }

        dispatch(event)
      }

      const onPointerUp = (native: PointerEvent): void => {
        const { screen, world } = coordsOf(native)
        const delta = deltaFrom(lastScreen, screen)
        lastScreen = screen

        const event = createPointerEvent({
          type: 'pointerup',
          screen,
          world,
          delta,
          buttons: native.buttons,
          pointerId: native.pointerId,
          ...downTarget(down),
          originalEvent: native,
        })

        // 手势只吃掉这一次 pointerup；原地抬手（位移在阈值内）之后仍会分发 click，
        // 需要区分「点击选中」与「点击触发的零位移手势」时，由处理器自行判断
        if (gesture) finishGesture(true)
        else dispatch(event)

        releaseCapture()

        dispatchTap(native, screen, world)
        down = null
      }

      const onPointerCancel = (native: PointerEvent): void => {
        // 系统抢占（触控板手势、指针丢失）一律按取消处理，不提交任何结果。
        // down 在分发前已清空，所以取消事件不带 targetNodeId / targetHandleId，
        // 处理器要撤销自身状态应在 beginGesture 的 onFinish(commit=false) 里做。
        if (gesture) finishGesture(false)
        releaseCapture()
        down = null
        dispatch(
          createPointerEvent({
            type: 'pointercancel',
            ...coordsOf(native),
            delta: { x: 0, y: 0 },
            buttons: native.buttons,
            pointerId: native.pointerId,
            originalEvent: native,
          }),
        )
      }

      /**
       * 指针离开舞台。
       *
       * 手势期间指针常常滑出舞台（指针捕获仍在送 move），离开不能打断手势，
       * 因此只在不处于手势时转发，供悬停高亮之类的状态做清理。
       */
      const onPointerLeave = (native: PointerEvent): void => {
        if (gesture) return
        updateStageRect()
        lastScreen = null
        dispatch(
          createPointerEvent({
            type: 'pointerleave',
            ...coordsOf(native),
            delta: { x: 0, y: 0 },
            buttons: 0,
            pointerId: native.pointerId,
            originalEvent: native,
          }),
        )
      }

      const onWheel = (native: WheelEvent): void => {
        // 滚轮期间画面缩放会改变舞台尺寸，每次重新测量 rect；
        // 滚动增量不映射到 delta（恒为 0），缩放插件自行读 originalEvent.deltaY
        updateStageRect()
        dispatch(
          createPointerEvent({
            type: 'wheel',
            ...coordsOf(native),
            delta: { x: 0, y: 0 },
            buttons: 0,
            pointerId: -1,
            originalEvent: native,
          }),
        )
      }

      const onKeyDown = (native: KeyboardEvent): void => {
        // Escape 是管线级保留键：有手势时优先取消并吞掉事件，处理器收不到这次按键
        if (gesture && native.key === 'Escape') {
          native.preventDefault()
          finishGesture(false)
          return
        }
        dispatch(createKeyboardEvent('keydown', native))
      }

      const onKeyUp = (native: KeyboardEvent): void => {
        dispatch(createKeyboardEvent('keyup', native))
      }

      const onContextMenu = (native: MouseEvent): void => {
        // 右键的 pointerdown 先于 contextmenu 触发，此时 down 仍在，能带上按下时的命中信息
        updateStageRect()
        dispatch(
          createPointerEvent({
            type: 'contextmenu',
            ...coordsOf(native),
            delta: { x: 0, y: 0 },
            buttons: native.buttons,
            pointerId: -1,
            ...downTarget(down),
            originalEvent: native,
          }),
        )
      }

      const onDoubleClick = (native: MouseEvent): void => {
        // dblclick 紧随第二次 pointerup，此时 down 已清空，事件不带 targetNodeId /
        // targetHandleId；双击打开编辑之类的处理器要自行用 screen 调 hitTest.at 判定
        dispatch(
          createPointerEvent({
            type: 'dblclick',
            ...coordsOf(native),
            delta: { x: 0, y: 0 },
            buttons: native.buttons,
            pointerId: -1,
            ...downTarget(down),
            originalEvent: native,
          }),
        )
      }

      /** 窗口尺寸变化只刷新 rect 缓存；舞台自身的位移由下一次按下或滚轮重新测量 */
      const onResize = (): void => updateStageRect()

      element.addEventListener('pointerdown', onPointerDown)
      element.addEventListener('pointermove', onPointerMove)
      element.addEventListener('pointerup', onPointerUp)
      element.addEventListener('pointercancel', onPointerCancel)
      element.addEventListener('pointerleave', onPointerLeave)
      element.addEventListener('wheel', onWheel, { passive: false })
      element.addEventListener('keydown', onKeyDown)
      element.addEventListener('keyup', onKeyUp)
      element.addEventListener('contextmenu', onContextMenu)
      element.addEventListener('dblclick', onDoubleClick)
      window.addEventListener('resize', onResize)

      return {
        dispose: () => {
          // 先摘掉全部监听，再收尾手势：避免 onFinish 里仍可能收到新的 pointermove
          element.removeEventListener('pointerdown', onPointerDown)
          element.removeEventListener('pointermove', onPointerMove)
          element.removeEventListener('pointerup', onPointerUp)
          element.removeEventListener('pointercancel', onPointerCancel)
          element.removeEventListener('pointerleave', onPointerLeave)
          element.removeEventListener('wheel', onWheel)
          element.removeEventListener('keydown', onKeyDown)
          element.removeEventListener('keyup', onKeyUp)
          element.removeEventListener('contextmenu', onContextMenu)
          element.removeEventListener('dblclick', onDoubleClick)
          window.removeEventListener('resize', onResize)

          if (gesture) finishGesture(false)
          releaseCapture()
          stage = null
          stageRect = null
          lastScreen = null
          down = null
        },
      }
    },
  }

  return service
}

/**
 * 取按下时解析到的命中信息。
 *
 * 存在是为了不把 `down.screen` / delta 一起重复展开进每个新事件：move / up / click /
 * 右键都只想要那两个可选 id。`down` 为 null（尚未按下或本次抬手已收尾）时返回空对象，
 * 事件上这两个字段因此是缺省而不是显式 undefined。
 */
function downTarget(value: DownHit | null): DownHit {
  return value ? { targetNodeId: value.targetNodeId, targetHandleId: value.targetHandleId } : {}
}

/**
 * 两次指针事件之间的屏幕位移。
 *
 * `prev` 为 null 表示没有前一次可比的位置（首次入场 / 指针离开舞台 / 解绑重挂），
 * 此时返回 0 而不是拿更早的按下点当基准，否则重新入场的第一个 move 会带一个巨大 delta。
 */
function deltaFrom(prev: ScreenPoint | null, screen: ScreenPoint): ScreenDelta {
  return prev ? { x: screen.x - prev.x, y: screen.y - prev.y } : { x: 0, y: 0 }
}

/**
 * 两点间的直线距离（舞台本地屏幕 CSS 像素）。
 *
 * 用欧氏距离而非位移分量之和：斜向拖拽分量都不大但总位移超过阈值时，
 * 按分量求和会被误判成点击。
 */
function distance(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
