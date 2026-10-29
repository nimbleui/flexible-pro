import type {
  SnapCandidate,
  SnapContext,
  SnapGuide,
  SnapInput,
  SnapProvider,
  SnapResult,
  SnapService,
} from '@lc/contracts'
import type { Disposable } from '@lc/kernel'

/** 吸附服务创建选项 */
export interface CreateSnapServiceOptions {
  /**
   * 是否启用吸附 @default true
   *
   * 只在建实例时取初值，运行期应通过服务的 `enabled` 开关修改；关闭后 resolve
   * 不执行任何 provider，直接返回空结果。
   */
  enabled?: boolean

  /**
   * 屏幕像素阈值 @default 6
   *
   * 引擎内部按 `阈值 / zoom` 换算成世界单位，使各缩放级别下手感一致。
   * 该值只在每次 resolve 时从本选项读取，改动服务上暴露的同名字段不会影响计算。
   */
  thresholdScreenPx?: number

  /**
   * provider 异常回调；失败只跳过该 provider
   *
   * 未传时异常被静默丢弃：吸附失败属于体验降级，不应打断拖拽主流程，但排查
   * 候选缺失时必须先接上这个回调。
   */
  onError?: (error: unknown, providerId: string) => void
}

/** thresholdScreenPx 未配置时的屏幕像素阈值 */
const DEFAULT_THRESHOLD = 6

/**
 * 无吸附结果的共享实例。
 *
 * 关闭吸附、rects 为空、无候选时都返回同一个对象，调用方不得就地修改其
 * delta 或 guides，否则会污染后续所有「未命中」判定。
 */
const NO_RESULT: SnapResult = { delta: { x: 0, y: 0 }, guides: [], matched: false }

/**
 * 创建吸附服务（引擎 + provider 注册）。
 *
 * 阈值以屏幕像素表示，内部按 zoom 换算成世界单位：`threshold / zoom`，
 * 保证 10% 与 400% 下手感一致。同一轴只应用一个吸附，但可显示多条辅助线。
 *
 * 引擎不区分候选来源：排除被拖元素自身、网格只吸附不画线都由 provider 通过
 * `priority` 与 `showGuide` 声明，避免内核写死「网格」「元素」这类插件语义。
 */
export function createSnapService(options: CreateSnapServiceOptions = {}): SnapService {
  const providers = new Map<string, SnapProvider>()
  const listeners = new Set<() => void>()

  let enabled = options.enabled ?? true

  // null 表示「从未解析或吸附已关闭」，覆盖层据此判断是否需要清空辅助线
  let lastResult: SnapResult | null = null

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  /**
   * 收集候选并计算 x / y 两轴的吸附。
   *
   * zoom 下限取 0.0001 而不是直接相除：视口在未测量阶段可能是 0，放大后的
   * 阈值会变成 Infinity，把所有候选全部判成命中。
   * x、y 各自独立选优，因此一次移动可能同时命中两条轴的吸附；
   * `angle` / `distance` 候选在这里不参与比较，只有 x / y 轴会被应用。
   *
   * @param input 移动中的世界矩形与当前视口信息
   */
  function resolve(input: SnapInput): SnapResult {
    if (!enabled || input.rects.length === 0) {
      return NO_RESULT
    }

    const threshold =
      (options.thresholdScreenPx ?? DEFAULT_THRESHOLD) / Math.max(input.zoom, 0.0001)
    const context: SnapContext = {
      zoom: input.zoom,
      viewportRect: input.viewportRect,
      moving: input.rects,
      thresholdWorld: threshold,
      movingIds: input.movingIds,
    }

    const candidates: SnapCandidate[] = []
    for (const provider of providers.values()) {
      try {
        candidates.push(...provider.getCandidates(context))
      } catch (error) {
        options.onError?.(error, provider.id)
      }
    }

    if (candidates.length === 0) return NO_RESULT

    const x = pickAxis(input, candidates, 'x', threshold)
    const y = pickAxis(input, candidates, 'y', threshold)
    const guides: SnapGuide[] = []

    if (x?.showGuide) {
      // axis 'x' 画的是竖线：value 取世界 x，range 补成视口的 y 跨度（两轴相反）
      guides.push({
        axis: 'x',
        value: x.value,
        source: x.source,
        range: x.range ?? [
          input.viewportRect.y,
          input.viewportRect.y + input.viewportRect.height,
        ],
      })
    }
    if (y?.showGuide) {
      guides.push({
        axis: 'y',
        value: y.value,
        source: y.source,
        range: y.range ?? [
          input.viewportRect.x,
          input.viewportRect.x + input.viewportRect.width,
        ],
      })
    }

    return {
      delta: { x: x?.diff ?? 0, y: y?.diff ?? 0 },
      guides,
      matched: Boolean(x ?? y),
    }
  }

  return {
    get enabled() {
      return enabled
    },

    /** 关闭时清空并广播 lastResult，让已绘制的辅助线立即消失；重新开启不补发通知。 */
    set enabled(next: boolean) {
      if (enabled === next) return
      enabled = next
      if (!next) {
        lastResult = null
        notify()
      }
    },

    /**
     * 当前生效阈值（屏幕像素）。
     *
     * 仅用于设置面板展示：构造时取一次选项值，resolve 每次仍重新读取原始选项，
     * 在这里赋值不会改变实际吸附距离。
     */
    thresholdScreenPx: options.thresholdScreenPx ?? DEFAULT_THRESHOLD,

    /**
     * 注册候选提供者。
     *
     * 候选按注册顺序收集，最终结果与顺序无关（比较规则见 `isBetter`）。
     *
     * @throws provider id 重复时抛错。
     */
    registerProvider(provider: SnapProvider): Disposable {
      if (providers.has(provider.id)) {
        throw new Error(`[canvas] 吸附 provider id 重复: ${provider.id}`)
      }
      providers.set(provider.id, provider)
      return {
        dispose: () => {
          // 比对实例引用：id 被重新注册后，旧的 Disposable 不能删掉当前 provider
          if (providers.get(provider.id) === provider) providers.delete(provider.id)
        },
      }
    },

    /**
     * 解析吸附结果并记录 lastResult。
     *
     * 关闭吸附时也会清掉上一轮结果并通知，防止辅助线残留。
     * 变化判定只比较 matched、delta 与 guides 数量：辅助线条数不变而位置或来源
     * 改变时不会通知，覆盖层应每帧主动读取 `lastResult` 而不是只依赖通知。
     */
    resolve(input) {
      if (!enabled) {
        if (lastResult !== null) {
          lastResult = null
          notify()
        }
        return NO_RESULT
      }

      const result = resolve(input)
      const changed =
        result.matched !== (lastResult?.matched ?? false) ||
        result.delta.x !== (lastResult?.delta.x ?? 0) ||
        result.delta.y !== (lastResult?.delta.y ?? 0) ||
        result.guides.length !== (lastResult?.guides.length ?? 0)

      lastResult = result
      if (changed) notify()
      return result
    },

    get lastResult() {
      return lastResult
    },

    onDidChange(listener): Disposable {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }
}

/** 单轴吸附命中结果（引擎内部结构，不对外暴露） */
interface AxisHit {
  /** 命中候选的世界坐标值，同时是辅助线绘制位置 */
  value: number

  /** 候选来源 id，原样透传到 SnapGuide 供覆盖层区分样式 */
  source: string

  /** candidate.value − 被拖矩形边；符号即修正方向，直接作为该轴的 delta */
  diff: number

  /** 候选优先级副本（未传时 0），只参与比较、不进 SnapGuide */
  priority: number

  /** 是否绘制辅助线；false 表示只做位置修正不画线（网格类候选常用） */
  showGuide: boolean

  /** 辅助线显示范围；缺失时由调用处补成整个视口跨度 */
  range?: [number, number]
}

/**
 * 在单轴上选择吸附候选：
 * priority 分层 → 层内距离最近 → source 稳定排序（字典序），保证结果可复现。
 */
function pickAxis(
  input: SnapInput,
  candidates: readonly SnapCandidate[],
  axis: 'x' | 'y',
  threshold: number,
): AxisHit | null {
  const edges: number[] = []
  for (const rect of input.rects) {
    if (axis === 'x') {
      edges.push(rect.x, rect.x + rect.width / 2, rect.x + rect.width)
    } else {
      edges.push(rect.y, rect.y + rect.height / 2, rect.y + rect.height)
    }
  }

  let best: AxisHit | null = null
  for (const candidate of candidates) {
    if (candidate.axis !== axis || !Number.isFinite(candidate.value)) continue

    for (const edge of edges) {
      const diff = candidate.value - edge
      const distance = Math.abs(diff)
      if (distance > threshold) continue

      const hit: AxisHit = {
        value: candidate.value,
        source: candidate.source,
        diff,
        priority: candidate.priority ?? 0,
        showGuide: candidate.showGuide ?? true,
        range: candidate.range,
      }

      if (!best || isBetter(hit, best)) best = hit
    }
  }
  return best
}

/**
 * 候选优劣比较：先分层再比距离。
 *
 * 网格候选是从被拖元素自身的边推导出来的，距离天然占优；若按距离优先，
 * 元素对齐会被自身几何挤掉，所以 priority 必须先于距离参与比较。
 */
function isBetter(a: AxisHit, b: AxisHit): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority
  const distanceA = Math.abs(a.diff)
  const distanceB = Math.abs(b.diff)
  if (distanceA !== distanceB) return distanceA < distanceB
  return a.source < b.source
}
