import type { Disposable } from '@lc/kernel'
import type { CanvasLayer, CanvasLayerService, LayerBand } from '@lc/contracts'

/**
 * band 的基础排序权重，数值小的在下层。
 *
 * 必须覆盖 `LayerBand` 的全部成员：漏一项会在比较时取到 undefined，
 * 使 sort 得到 NaN 而退化成不稳定的图层顺序。新增 band 时两处要同时改。
 */
const BAND_ORDER: Record<LayerBand, number> = {
  background: 0,
  content: 1,
  selection: 2,
  guides: 3,
  handles: 4,
  preview: 5,
  hud: 6,
  modal: 7,
}

/**
 * 图层登记项。
 *
 * 排序权重复合在 `sorted` 里现算，登记项只存定义与序号，因此插件改 zIndex 后
 * 无需 invalidate，下一次 `list()` 自然生效。
 */
interface LayerEntry {
  /**
   * 覆盖层定义本体。
   *
   * `list()` 原样返回这个引用，不做拷贝：插件在 mount 里改 mount 元素是预期行为，
   * 但外部改写 band / zIndex 会绕过排序约定。
   */
  layer: CanvasLayer

  /**
   * 注册时的单调递增序号（从 1 开始，0 保留给「未登记」）。
   *
   * band 与 zIndex 都相同时用它保证先到先得，使图层顺序可复现。
   */
  seq: number
}

/**
 * 创建覆盖层注册表。
 *
 * 覆盖层统一挂在一个 LayerHost 下，按 band → zIndex → 注册顺序排序；
 * 插件不能直接改 DOM 的 z-index，否则拖拽临时层会与常驻层打架。
 */
export function createLayerService(): CanvasLayerService {
  const layers = new Map<string, LayerEntry>()
  const listeners = new Set<() => void>()

  // 单调递增的注册序号：band 与 zIndex 都相同时用它保持先到先得的稳定顺序
  let seq = 0

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  /**
   * 按 band → zIndex → 注册顺序排出底到顶的图层。
   *
   * 每次调用重新排序并返回新数组，图层数量小、不做增量维护；注册与注销
   * 都只需改 Map，排序结果不会残留旧引用。
   */
  function sorted(): CanvasLayer[] {
    return [...layers.values()]
      .sort((a, b) => {
        const bandDiff = BAND_ORDER[a.layer.band] - BAND_ORDER[b.layer.band]
        if (bandDiff !== 0) return bandDiff
        const zDiff = (a.layer.zIndex ?? 0) - (b.layer.zIndex ?? 0)
        if (zDiff !== 0) return zDiff
        return a.seq - b.seq
      })
      .map((entry) => entry.layer)
  }

  return {
    /**
     * 注册覆盖层。
     *
     * id 冲突视为装配错误而不是静默覆盖：两个插件用同一 id 会让先注册的一方
     * 永远无法被替换或清理。
     *
     * @throws 图层 id 已存在时抛错。
     */
    register(layer): Disposable {
      if (layers.has(layer.id)) {
        throw new Error(`[canvas] 图层 id 重复: ${layer.id}`)
      }
      const entry = { layer, seq: ++seq }
      layers.set(layer.id, entry)
      notify()

      return {
        dispose: () => {
          // 比对 entry 引用：id 被重新登记后，重复执行的 dispose 不能删掉当前图层
          if (layers.get(layer.id) !== entry) return
          layers.delete(layer.id)
          notify()
        },
      }
    },

    list() {
      return sorted()
    },

    onDidChange(listener): Disposable {
      // listeners 是 Set：同一函数重复注册只保留一份，任一 Disposable 释放即全部失效
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }
}
