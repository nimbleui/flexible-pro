import type { Disposable } from '@lc/kernel'
import type { Rect, Size } from '@lc/schema'
import type { SceneService } from '@lc/contracts'
import { unionRects } from './geometry'

/** 场景创建选项 */
export interface CreateSceneOptions {
  /**
   * 文档根包围盒；由画布宿主从根节点 layout 计算
   *
   * 每次 `getRootBounds` / `getRootSize` 都实时调用，结果不缓存，所以宿主改完
   * 文档尺寸不需要再 invalidate。必须是同步纯读取，不允许在内部登记节点几何。
   */
  getRootRect: () => Rect
}

/**
 * 节点几何登记项。
 *
 * 独立成类型是为了让「存的是拷贝」这件事写在字段注释里，而不是藏在 register 的
 * 展开语法中——`getBounds` 返回的就是这个对象持有的引用。
 */
interface SceneEntry {
  /**
   * 节点未旋转的世界矩形。
   *
   * 单位是画布逻辑坐标（世界像素），原点为场景坐标系 (0,0)，与视口 zoom / origin
   * 无关；宽高为非负数，旋转不进这里，由命中测试按 `getRotation` 单独补偿。
   */
  rect: Rect
}

/**
 * 创建场景图（节点几何索引）。
 *
 * 骨架阶段的几何来源是 `layout.rect`：绝对定位画布不需要读 DOM，
 * 手势期间也不会触发布局回流。登记顺序即绘制顺序（底 → 顶），
 * 命中测试按逆序取最上层。
 */
export function createScene(options: CreateSceneOptions): SceneService {
  const entries = new Map<string, SceneEntry>()

  // 绘制与命中的层级权威：首次登记时追加，节点卸载时移除，重复登记不改变位置
  const order: string[] = []
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  return {
    /**
     * 登记或更新节点几何。
     *
     * rect 会被浅拷贝保存，调用方后续修改入参不影响场景。重复登记同一 nodeId
     * 只替换几何、不追加顺序，因此文档逐节点重同步不会打乱绘制层级；每次登记
     * 都会广播一次变化。
     */
    register(nodeId, rect): Disposable {
      const entry: SceneEntry = { rect: { ...rect } }

      if (!entries.has(nodeId)) order.push(nodeId)
      entries.set(nodeId, entry)
      notify()

      return {
        dispose: () => {
          // 只删除自己登记的那一条，避免重挂载时误删新几何
          if (entries.get(nodeId) !== entry) return
          entries.delete(nodeId)
          const index = order.indexOf(nodeId)
          if (index >= 0) order.splice(index, 1)
          notify()
        },
      }
    },

    getBounds(nodeId) {
      // 返回的是场景内部持有的矩形对象，调用方要改必须先复制
      return entries.get(nodeId)?.rect
    },

    getBoundsOf(ids) {
      // 未登记的 id 被过滤掉；ids 全部未登记时返回 undefined 而不是零尺寸矩形
      return unionRects(
        ids
          .map((id) => entries.get(id)?.rect)
          .filter((rect): rect is Rect => rect !== undefined),
      )
    },

    getRootSize(): Size {
      const rect = options.getRootRect()
      return { width: rect.width, height: rect.height }
    },

    getRootBounds(): Rect {
      return options.getRootRect()
    },

    invalidate() {
      // 几何由 register 提供，没有独立测量缓存；这里只广播变化，
      // 让覆盖层与属性面板重新读取最新 rect。
      // 契约上的 nodeIds 参数在骨架阶段不生效：无法只失效部分节点。
      notify()
    },

    list() {
      // 直接暴露内部登记数组（避免每帧复制），调用方不得 push/splice/sort
      return order
    },

    onDidChange(listener): Disposable {
      // listeners 是 Set：同一函数重复注册只保留一份，任一 Disposable 释放即全部失效
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }
}
