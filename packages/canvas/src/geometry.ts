import type { Rect } from '@lc/schema'
import type { Matrix2D, Point } from '@lc/contracts'

/**
 * 单位矩阵，表示「不做任何变换」。
 *
 * 全库共享的只读实例：`Matrix2D` 是 readonly 元组，调用方不可就地修改，
 * 需要派生新变换时用 `multiplyMatrix`，否则会污染所有引用方。
 */
export const IDENTITY: Matrix2D = [1, 0, 0, 1, 0, 0]

/**
 * 把矩阵作用于点：`(x, y) → (a·x + c·y + e, b·x + d·y + f)`。
 *
 * 纯计算，结果不做取整：命中测试依赖小数坐标，提前取整会让边界像素抖动。
 */
export function applyMatrix(matrix: Matrix2D, point: Point): Point {
  const [a, b, c, d, e, f] = matrix
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f }
}

/**
 * 矩阵乘：先应用 right，再应用 left。
 *
 * 与 `applyMatrix(multiplyMatrix(left, right), p)` 等价于
 * `applyMatrix(left, applyMatrix(right, p))`，顺序写反即得到错误的变换。
 * 入参只读，结果始终是新数组。
 */
export function multiplyMatrix(left: Matrix2D, right: Matrix2D): Matrix2D {
  const [a1, b1, c1, d1, e1, f1] = left
  const [a2, b2, c2, d2, e2, f2] = right
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

/**
 * 求逆矩阵。
 *
 * 只处理仿射部分：行列式接近 0 视为不可逆，不做伪逆降级，因为缩放被压到
 * 0 时继续换算只会产出 Infinity 坐标，把错误推迟到更难定位的渲染阶段。
 *
 * @throws 矩阵不可逆（行列式为 0，通常是 zoom=0）时抛错。
 */
export function invertMatrix(matrix: Matrix2D): Matrix2D {
  const [a, b, c, d, e, f] = matrix
  const determinant = a * d - b * c
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error('[canvas] 矩阵不可逆')
  }
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ]
}

/**
 * 矩形是否包含世界坐标点（含边界）。
 *
 * 只按 x/y/width/height 判定，不感知节点 rotation；旋转节点请用
 * `rotatedRectContainsPoint`。宽高为 0 时矩形退化为线或点，边界包含规则仍然成立。
 */
export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

/** 两个矩形是否相交（含边界接触）。 */
export function rectIntersects(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  )
}

/**
 * 把「绕自身中心旋转」的矩形展开成世界坐标四角。
 *
 * 入参 rect 是未旋转的世界矩形，与 CSS `rotate()` 语义一致：先按 rect 定位、
 * 再绕矩形中心旋转，所以宽高不变而外包络变。返回顺序只作顶点集合使用。
 */
export function rotatedRectCorners(rect: Rect, radians: number): Point[] {
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const half = { x: rect.width / 2, y: rect.height / 2 }
  const corners: Point[] = []

  for (const signX of [-1, 1]) {
    for (const signY of [-1, 1]) {
      const dx = signX * half.x
      const dy = signY * half.y
      corners.push({ x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos })
    }
  }

  return corners
}

/**
 * 旋转矩形是否包含世界坐标点（含边界）。
 *
 * 判定把点反向旋转回矩形的局部轴再做 AABB 比较，比拿外包络判定更准：旋转 45°
 * 的窄条外包络明显变大，按外包络会点中它旁边的空白。
 *
 * `radians` 为 0 走 AABB 快路径，省掉指针高频路径上的三角函数；为非有限值时同样
 * 退化成 AABB，坏角度应让节点按未旋转命中，而不是彻底点不中。
 */
export function rotatedRectContainsPoint(rect: Rect, radians: number, point: Point): boolean {
  if (!Number.isFinite(radians) || radians === 0) return rectContainsPoint(rect, point)

  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = point.x - (rect.x + rect.width / 2)
  const dy = point.y - (rect.y + rect.height / 2)
  // 逆旋转是正旋转的转置：[[cos, sin], [-sin, cos]]
  const localX = cos * dx + sin * dy
  const localY = -sin * dx + cos * dy

  return Math.abs(localX) <= rect.width / 2 && Math.abs(localY) <= rect.height / 2
}

/**
 * 旋转矩形与轴对齐矩形是否相交（含边界接触），框选用它。
 *
 * 被框到的旋转节点必须真的与框有公共部分：只比未旋转的 AABB 会漏选转出框外的
 * 节点，改用外包络又会多选到框内的空白。分离轴取轴对齐矩形的 x/y 轴加旋转矩形
 * 的两条局部轴，四条轴上任意一条投影不重叠即判定为不相交。
 */
export function rotatedRectIntersectsRect(rect: Rect, radians: number, other: Rect): boolean {
  if (!Number.isFinite(radians) || radians === 0) return rectIntersects(rect, other)

  const rotated = rotatedRectCorners(rect, radians)
  const axisAligned = [
    { x: other.x, y: other.y },
    { x: other.x + other.width, y: other.y },
    { x: other.x + other.width, y: other.y + other.height },
    { x: other.x, y: other.y + other.height },
  ]
  const axes: Point[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: Math.cos(radians), y: Math.sin(radians) },
    { x: -Math.sin(radians), y: Math.cos(radians) },
  ]

  return axes.every((axis) => {
    const a = projectExtent(rotated, axis)
    const b = projectExtent(axisAligned, axis)
    return a.min <= b.max && b.min <= a.max
  })
}

/** 点集在轴上的投影区间；轴不必单位化，区间比较只看相对次序。 */
function projectExtent(points: readonly Point[], axis: Point): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (const point of points) {
    const value = point.x * axis.x + point.y * axis.y
    if (value < min) min = value
    if (value > max) max = value
  }

  return { min, max }
}

/**
 * 由两个对角点构造规范矩形（宽高恒为正）。
 *
 * from / to 不要求先后顺序，反向拖拽同样得到同一矩形；两点重合时得到
 * 零面积矩形而不是 undefined，框选为零面积时由调用方自行忽略。
 */
export function normalizeRect(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  }
}

/**
 * 多个矩形求并集；空集合返回 undefined。
 *
 * 结果是外包络（AABB），中间空洞不影响返回矩形；调用方不能据此判断
 * 「两个节点之间有重叠」，那是 `rectIntersects` 的职责。
 */
export function unionRects(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const rect of rects) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * 绕原点旋转（弧度），用于视口 rotation 与节点 AABB 粗筛。
 *
 * 旋转中心固定为世界原点 (0,0)：围绕任意锚点旋转时，调用方需先平移到锚点、
 * 再平移回来。弧度不做归一化，超出 [0, 2π) 或负值结果同样正确。
 */
export function rotatePoint(point: Point, radians: number): Point {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  }
}
