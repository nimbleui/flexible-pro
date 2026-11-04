import type { Point } from '@lc/contracts'
import type { NodeSchema, Rect, SlotDefinition } from '@lc/schema'

/** 默认插槽名；落点没命中任何区域时优先落到它，都没有才落 children */
const DEFAULT_SLOT = 'default'

/** 落点判定的一次输入；全部是调用方已算好的数据，本模块不读文档也不测 DOM */
export interface SlotTargetInput {
  /** 命中的容器节点，插槽与占用都从它身上取 */
  container: NodeSchema

  /** 按组件名查物料声明的插槽，通常是 `material.get(name)?.slots` */
  slotsOf: (componentName: string) => SlotDefinition[] | undefined

  /** 容器的未旋转世界矩形，来自 `canvas.measure.measure` */
  bounds: Rect | undefined

  /** 落点世界坐标 */
  world: Point

  /** 容器自转角，弧度；与命中测试同一口径 */
  rotation: number

  /** 被拖入的物料名，用于 `accepts` 判定 */
  materialName: string
}

/**
 * 判定本次落点应该写进容器的那个具名插槽，返回 undefined 表示写 `children`。
 *
 * 插槽声明只认 `container.componentName` 对应的物料：分格属于被放进去的那个容器，
 * 与正在被拖的物料无关。这里故意收 `slotsOf` 而不是让调用方直接传数组，就是为了让
 * 「把被拖物料的 slots 传进来」这类写错变成不可表示。
 *
 * 降级顺序是「命中区域 → default → children」，而不是「命中区域 → 按声明顺序找第一个
 * 可收插槽」：把中部落点塞进 header 只会让用户看到节点出现在谁都没要的地方，而
 * children + default 任何组件都收得住。命中的那一格满了或被 `accepts` 拒了同样降级，
 * 绝不因为约束不满足就丢节点。
 */
export function resolveSlotTarget(input: SlotTargetInput): string | undefined {
  const { container, slotsOf, bounds, world, rotation, materialName } = input
  const slots = slotsOf(container.componentName)
  if (!slots?.length || !bounds) return undefined

  const occupancy = (slot: string) => container.slots?.[slot]?.length ?? 0
  const local = toLocalAxis(bounds, world, rotation)
  const hit = slots.find((slot) => regionContains(regionOf(slot), local))
  if (hit && isAdmissible(hit, materialName, occupancy)) return hit.name

  const fallback = slots.find((slot) => slot.name === DEFAULT_SLOT)
  return fallback && isAdmissible(fallback, materialName, occupancy) ? fallback.name : undefined
}

/**
 * 插槽的可收性：`accepts` 为空表示不限，`maxChildren` 未设或为 0 表示不限。
 *
 * 两处「空即不限制」都来自 `SlotDefinition` 自己的字段语义，不在这里另立规则。
 */
function isAdmissible(
  slot: SlotDefinition,
  materialName: string,
  occupancy: (slot: string) => number,
): boolean {
  const accepts = slot.accepts
  if (accepts?.length && !accepts.includes(materialName)) return false

  const max = slot.maxChildren ?? 0
  return max <= 0 || occupancy(slot.name) < max
}

/**
 * 把落点换算到「以容器左上角为原点、容器宽高为 1」的比例坐标系。
 *
 * 回转必须绕**容器中心**：平台的旋转语义是「绕自身中心旋转」
 * （`canvas/src/geometry.ts` 的 `rotatedRectContainsPoint`），绕左上角回转会让旋转后的
 * 分格整体偏移到一个谁都没声明的位置。角度非有限时按未旋转处理，与命中测试的
 * 同一条兜底规则一致——坏角度不该让落点判定彻底失效。
 */
function toLocalAxis(bounds: Rect, world: Point, rotation: number): Point {
  const radians = Number.isFinite(rotation) ? rotation : 0
  const dx = world.x - (bounds.x + bounds.width / 2)
  const dy = world.y - (bounds.y + bounds.height / 2)

  // CSS rotate 为正时顺时针，反变换即把向量回转 -radians；为 0 时是恒等
  const cos = Math.cos(-radians)
  const sin = Math.sin(-radians)
  const localX = dx * cos - dy * sin + bounds.width / 2
  const localY = dx * sin + dy * cos + bounds.height / 2

  return {
    x: bounds.width ? localX / bounds.width : 0,
    y: bounds.height ? localY / bounds.height : 0,
  }
}

/** 插槽的区域比例；未声明 region 表示覆盖整个容器 */
function regionOf(slot: SlotDefinition): Rect {
  const region = slot.region
  return {
    x: region?.x ?? 0,
    y: region?.y ?? 0,
    width: region?.width ?? 1,
    height: region?.height ?? 1,
  }
}

/** 单位比例区间命中判定；右边缘取开区间，避免两格首尾相接时同一落点命中两次 */
function regionContains(region: Rect, point: Point): boolean {
  return (
    point.x >= region.x &&
    point.y >= region.y &&
    point.x < region.x + region.width &&
    point.y < region.y + region.height
  )
}
