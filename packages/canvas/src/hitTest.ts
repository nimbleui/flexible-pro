import type {
  HitTestService,
  MeasureService,
  Point,
  SceneService,
  ViewportService,
} from '@lc/contracts'
import type { Rect } from '@lc/schema'
import { rotatedRectContainsPoint, rotatedRectIntersectsRect } from './geometry'

/** 命中测试创建选项 */
export interface CreateHitTestOptions {
  /** 场景图；几何取自登记的世界矩形，不读取 DOM */
  scene: SceneService

  /** 视口换算；`at` / `containerAt` 用它做 screen→world，`inRect` 用它换算四角 */
  viewport: ViewportService

  /**
   * 判断节点是否可作为容器接收子节点
   *
   * 只被 `containerAt` 使用，`at` 与 `inRect` 不受它影响；命中测试会对候选节点
   * 逐个调用，必须是同步廉价函数且不做 DOM 测量。
   */
  isContainer: (nodeId: string) => boolean

  /**
   * 取节点自转角（弧度）
   *
   * 命中判定据此将指针换算回节点的局部轴，未旋转的节点返回 0 即可。
   * 只表示节点自身的旋转：渲染层对嵌套子树做的是坐标补偿，祖先旋转对子节点的
   * 影响目前既不在此合成、也不在渲染层合成。必须是同步廉价函数。
   */
  getRotation: (nodeId: string) => number

  /**
   * 判断节点是否可被选中（点选与框选）
   *
   * 缺省视为全部可选。锁定节点返回 false 后，指针会穿过它命中下方节点、框选也不再
   * 收进它；`containerAt` 故意不受它影响，否则锁定容器会变成不可投递的黑洞。
   */
  isSelectable?: (nodeId: string) => boolean
}

/** 未提供可选性判定时视为全部可选 */
function alwaysSelectable(): boolean {
  return true
}

/**
 * 创建命中测试服务。
 *
 * 几何取自场景登记的 `layout.rect`（未旋转世界矩形）并按 `getRotation` 补上节点
 * 自转，因此点选与框选的判定结果和渲染层的 CSS rotate 一致；不读取 DOM。
 */
export function createHitTest(options: CreateHitTestOptions): HitTestService {
  const { scene, viewport, getRotation } = options
  const isSelectable = options.isSelectable ?? alwaysSelectable

  /**
   * 逆序扫描登记顺序取最上层命中。
   *
   * filter 在读几何之前执行，让容器筛选少算一批包围盒；返回的是第一个命中节点，
   * 因此叠放层级由场景登记顺序决定，与 rect 面积无关。
   *
   * @param world 世界坐标点（画布逻辑单位，已含视口 origin 平移、不含 zoom），
   * 调用方负责先经 `viewport.screenToWorld` 换算，这里不再读视口。
   * @param filter 候选准入谓词；返回 false 的节点直接跳过，不参与几何比较。
   */
  function atWorld(world: Point, filter?: (id: string) => boolean) {
    const ids = scene.list()
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const nodeId = ids[index] as string
      if (filter && !filter(nodeId)) continue
      const rect = scene.getBounds(nodeId)
      if (rect && rotatedRectContainsPoint(rect, getRotation(nodeId), world)) return nodeId
    }
    return undefined
  }

  return {
    at(screen) {
      // 覆盖层不进场景登记，因此天然不参与命中，无需额外过滤
      return atWorld(viewport.screenToWorld(screen), isSelectable)
    },

    /** 返回值保持场景登记顺序（底 → 顶），不按距离或面积排序。 */
    inRect(screenRect) {
      // 视口旋转时不能只取两个角：用四角 AABB 保证不漏选
      const corners = [
        viewport.screenToWorld({ x: screenRect.x, y: screenRect.y }),
        viewport.screenToWorld({
          x: screenRect.x + screenRect.width,
          y: screenRect.y,
        }),
        viewport.screenToWorld({
          x: screenRect.x,
          y: screenRect.y + screenRect.height,
        }),
        viewport.screenToWorld({
          x: screenRect.x + screenRect.width,
          y: screenRect.y + screenRect.height,
        }),
      ]

      const xs = corners.map((corner) => corner.x)
      const ys = corners.map((corner) => corner.y)
      const minX = Math.min(...xs)
      const minY = Math.min(...ys)
      const bounds: Rect = {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
      }

      return scene.list().filter((nodeId) => {
        if (!isSelectable(nodeId)) return false
        const rect = scene.getBounds(nodeId)
        return rect ? rotatedRectIntersectsRect(rect, getRotation(nodeId), bounds) : false
      })
    },

    containerAt(screen) {
      // 非容器节点会被跳过并继续向下查找，所以覆盖在容器上的子节点不会挡住拖入判定
      const world = viewport.screenToWorld(screen)
      return atWorld(world, (nodeId) => options.isContainer(nodeId))
    },
  }
}

/**
 * 创建测量服务。
 *
 * 与场景共用几何数据，避免第二套缓存；`measureMany` 只是批量读取，
 * 不会触发 DOM 布局。
 */
export function createMeasure(scene: SceneService): MeasureService {
  return {
    measure(nodeId) {
      return scene.getBounds(nodeId)
    },

    measureMany(ids) {
      // 未登记的 id 直接缺席而不是返回 undefined 项，调用方按 has() 判断存在性
      const result = new Map<string, Rect>()
      for (const id of ids) {
        const rect = scene.getBounds(id)
        if (rect) result.set(id, rect)
      }
      return result
    },
  }
}
