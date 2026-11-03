import type { Point, Rect } from '@lc/contracts'

/**
 * 新建节点的落点避让。
 *
 * 点击节点库条目时落点固定是视口中心，连续添加会把这些节点叠在同一个坐标上：
 * 卡片叠在一起后，输出端口的屏幕位置命中到的是最上面那张卡片的端口，拉线时起点与
 * 终点被解析成同一个节点，连线被当成自环拒绝——看起来就是「连不上线」。
 */

/** 每次避让沿对角线让开的距离，小于节点宽高，所以要连续让几次才能完全错开 */
const PLACEMENT_STEP = 36

/** 找不到空位时最多尝试的次数 */
const MAX_PLACEMENT_TRIES = 24

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  )
}

/**
 * 为新建节点找一个不与既有节点重叠的左上角。
 *
 * 纯几何，不读 DOM：入参是期望落点与既有节点的世界矩形，同一输入必得同一输出。
 * 空位判定按完整矩形相交，因此新节点的端口不会被任何既有卡片压住。
 *
 * @param world 期望落点（新节点的左上角）
 * @param size 新节点宽高
 * @param occupied 既有节点的世界矩形
 * @returns 可直接写入文档的左上角坐标；期望位置本就空着时原样返回
 */
export function firstFreePosition(
  world: Point,
  size: { width: number; height: number },
  occupied: readonly Rect[],
): Point {
  const isFree = (candidate: Point): boolean => {
    const rect: Rect = { ...candidate, width: size.width, height: size.height }

    return !occupied.some((other) => intersects(rect, other))
  }

  for (let index = 0; index <= MAX_PLACEMENT_TRIES; index++) {
    const candidate = {
      x: world.x + index * PLACEMENT_STEP,
      y: world.y + index * PLACEMENT_STEP,
    }
    if (isFree(candidate)) return candidate
  }

  // 视口中心被围死时仍要落一个节点，否则「点了没反应」比压住既有卡片更难排查
  return {
    x: world.x + MAX_PLACEMENT_TRIES * PLACEMENT_STEP,
    y: world.y + MAX_PLACEMENT_TRIES * PLACEMENT_STEP,
  }
}
