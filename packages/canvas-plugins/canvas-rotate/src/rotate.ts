import type { Point } from '@lc/contracts'
import type { Rect } from '@lc/schema'

/** 可旋转节点快照 */
export interface RotatableNode {
  /** 节点 id，用于回到 patch 路径 */
  id: string
  /** 未旋转的世界矩形；旋转只改 rotate，宽高与矩形尺寸保持不变 */
  rect: Rect
  /** 当前旋转角度（度） */
  rotate: number
}

/**
 * 把角度归一化到 `(-180, 180]`。
 *
 * 统一符号区间，避免多次旋转后角度无限增长、历史 patch 出现 3600 之类的值。
 */
export function normalizeDegrees(value: number): number {
  let next = value % 360
  if (next > 180) next -= 360
  if (next <= -180) next += 360
  return next
}

/**
 * 角度吸附：把弧度吸附到 `stepDeg` 的整数倍。
 *
 * 用于 Shift 旋转步进（默认 15°），吸附在弧度空间完成，避免度/弧度来回换算误差。
 * 吸附以 0 弧度为基准，所以调用方传的应是相对起点的增量而不是绝对角度，
 * 否则按住 Shift 起拖时会先跳到最近的步长上。
 */
export function snapRadians(radians: number, stepDeg = 15): number {
  const step = (stepDeg * Math.PI) / 180
  return Math.round(radians / step) * step
}

/**
 * 绕组中心旋转多选节点。
 *
 * 每个节点做两件事：
 * 1. 节点中心绕组中心旋转 `deltaRadians`；
 * 2. 自身角度累加 `deltaDegrees` 并归一化。
 *
 * 返回新数组，不修改入参，便于事务预览与测试。
 *
 * 矩形宽高保持不变：schema 存的是未旋转矩形，视觉尺寸由 rotate 渲染时体现，
 * 因此这里只需重新落位中心点。
 */
export function rotateNodes(
  nodes: readonly RotatableNode[],
  center: { x: number; y: number },
  deltaRadians: number,
): RotatableNode[] {
  const cos = Math.cos(deltaRadians)
  const sin = Math.sin(deltaRadians)
  const deltaDegrees = (deltaRadians * 180) / Math.PI

  return nodes.map((node) => {
    const nodeCenterX = node.rect.x + node.rect.width / 2
    const nodeCenterY = node.rect.y + node.rect.height / 2
    const dx = nodeCenterX - center.x
    const dy = nodeCenterY - center.y
    const nextCenterX = center.x + dx * cos - dy * sin
    const nextCenterY = center.y + dx * sin + dy * cos

    return {
      id: node.id,
      rect: {
        ...node.rect,
        x: nextCenterX - node.rect.width / 2,
        y: nextCenterY - node.rect.height / 2,
      },
      rotate: normalizeDegrees(node.rotate + deltaDegrees),
    }
  })
}

/** 旋转手柄的屏幕位置（顶边中点 + 手柄中心） */
export interface RotateHandlePlacement {
  /** 包围盒顶边中点（旋转后） */
  topMid: Point
  /** 手柄圆心（旋转后） */
  handle: Point
}

/**
 * 计算旋转手柄位置：以包围盒中心为支点，把「顶边中点」与「头顶外扩点」
 * 一起按选区旋转角旋转，使手柄始终贴在旋转后的顶边上。
 *
 * 多选时传入 0，退化为普通 AABB 顶边。
 *
 * 入参与返回值全部在屏幕空间，世界矩形必须先按 zoom 换算再传进来，
 * 否则手柄会随缩放一起变大变小。
 *
 * @param center 包围盒中心的屏幕坐标
 * @param halfHeight 包围盒半高（屏幕像素）
 * @param offset 顶边外到手柄圆心的距离（屏幕像素）
 * @param rotation 选区旋转弧度
 */
export function placeRotateHandle(
  center: Point,
  halfHeight: number,
  offset: number,
  rotation: number,
): RotateHandlePlacement {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const rotateVector = (vector: Point): Point => ({
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
  })

  const edge = rotateVector({ x: 0, y: -halfHeight })
  const knob = rotateVector({ x: 0, y: -(halfHeight + offset) })

  return {
    topMid: { x: center.x + edge.x, y: center.y + edge.y },
    handle: { x: center.x + knob.x, y: center.y + knob.y },
  }
}
