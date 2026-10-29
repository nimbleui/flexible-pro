import type { Rect } from '@lc/schema'

/** 组/单节点缩放的最小边长（世界像素） */
export const MIN_RESIZE_SIZE = 8

/** 单节点在组缩放中的最小边长；允许比组下限更小，避免薄元素被强行撑大 */
const MIN_NODE_SIZE = 1

export interface ResizeRectOptions {
  /**
   * 最小边长 @default MIN_RESIZE_SIZE
   *
   * 同时是拖拽上限：手柄越过对边时 x/y 被夹住而不是翻转矩形，宽高永不为负。
   */
  minSize?: number

  /**
   * 保持宽高比；仅角手柄生效 @default false
   *
   * 生效时结果按 `MIN_RESIZE_SIZE` 而不是本项 minSize 兜底，两者不同值时下限会不一致。
   */
  keepAspect?: boolean
}

/**
 * 判断手柄 id 是否为四角之一。
 *
 * id 取值必须与覆盖层渲染的手柄名保持一致；新增角手柄要同时改这里，
 * 否则等比缩放会静默失效。
 */
export function isCornerHandle(handleId: string): boolean {
  return handleId === 'nw' || handleId === 'ne' || handleId === 'se' || handleId === 'sw'
}

/**
 * 按手柄方向计算新矩形。
 *
 * 以「对边/对角固定」为锚点；最小尺寸兜底，避免矩形翻转成负宽高。
 * `keepAspect` 只对角手柄生效：边缘手柄只有一个自由度，强制等比会让
 * 手柄脱离指针，交互反而不可预测。
 *
 * 方位靠 handleId 里的 n / s / e / w 字符判定，单边与四角因此共用一套逻辑。
 * 这是子串匹配：任何名字里带这四个字母的手柄都会被当作对应方位（`rotate` 含
 * `e` 会被当成东手柄），调用方必须先排除非缩放手柄；完全不含这四个字符时
 * 四个分支都不命中，原样返回入参矩形。
 */
export function resizeRect(
  rect: Rect,
  handleId: string,
  point: { x: number; y: number },
  options: ResizeRectOptions = {},
): Rect {
  const minSize = options.minSize ?? MIN_RESIZE_SIZE
  let { x, y, width, height } = rect
  const right = x + width
  const bottom = y + height

  if (handleId.includes('w')) {
    const nextX = Math.min(point.x, right - minSize)
    x = nextX
    width = right - nextX
  }
  if (handleId.includes('e')) {
    width = Math.max(minSize, point.x - x)
  }
  if (handleId.includes('n')) {
    const nextY = Math.min(point.y, bottom - minSize)
    y = nextY
    height = bottom - nextY
  }
  if (handleId.includes('s')) {
    height = Math.max(minSize, point.y - y)
  }

  const resized: Rect = { x, y, width, height }
  if (!options.keepAspect || !isCornerHandle(handleId)) return resized
  return withAspect(rect, resized, handleId)
}

/**
 * 角手柄等比：以对角为锚点，按指针主导轴决定缩放比例。
 *
 * 以变化更大的轴为准（而不是取两个轴的较小值），保证手柄跟随指针的方向。
 */
function withAspect(start: Rect, next: Rect, handleId: string): Rect {
  if (start.width <= 0 || start.height <= 0) return next

  const ratio = start.width / start.height
  const drivenByWidth =
    Math.abs(next.width - start.width) >= Math.abs(next.height - start.height)
  const width = Math.max(MIN_RESIZE_SIZE, drivenByWidth ? next.width : next.height * ratio)
  const height = Math.max(MIN_RESIZE_SIZE, drivenByWidth ? next.width / ratio : next.height)

  switch (handleId) {
    case 'se':
      return { x: start.x, y: start.y, width, height }
    case 'ne':
      return { x: start.x, y: start.y + start.height - height, width, height }
    case 'sw':
      return { x: start.x + start.width - width, y: start.y, width, height }
    case 'nw':
      return {
        x: start.x + start.width - width,
        y: start.y + start.height - height,
        width,
        height,
      }
    default:
      return next
  }
}

/** 参与组缩放的节点快照 */
export interface SelectionNode {
  /** 节点 id，同时是 patch 路径的一部分 */
  id: string

  /** 手势开始时的世界矩形；组缩放以它为映射基准，不能传实时几何 */
  rect: Rect
}

/** 旋转感知缩放输入 */
export interface RotatedResizeInput {
  /** 未旋转的节点矩形（schema layout.rect）；旋转信息只放在 rotation 里 */
  rect: Rect
  /** 节点旋转弧度 */
  rotation: number
  /** 手柄方位 */
  handleId: string

  /** 指针世界坐标；函数内部先反旋转回节点局部坐标系再算尺寸 */
  point: { x: number; y: number }

  /** 保持宽高比（仅角手柄） @default false */
  keepAspect?: boolean
  /** 最小边长 @default MIN_RESIZE_SIZE */
  minSize?: number
}

/**
 * 绕任意中心旋转折点；传 `-rotation` 即为逆变换（世界 → 局部）。
 *
 * 与 `@lc/canvas` 的 `rotatePoint` 区别在于旋转中心不是世界原点。
 */
function rotateAround(
  point: { x: number; y: number },
  center: { x: number; y: number },
  radians: number,
): { x: number; y: number } {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = point.x - center.x
  const dy = point.y - center.y
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  }
}

/** 手柄的对侧锚点（局部坐标）：拖 west 时锚右边，拖 se 时锚 nw 角。 */
function anchorPoint(rect: Rect, handleId: string): { x: number; y: number } {
  const x = handleId.includes('w')
    ? rect.x + rect.width
    : handleId.includes('e')
      ? rect.x
      : rect.x + rect.width / 2
  const y = handleId.includes('n')
    ? rect.y + rect.height
    : handleId.includes('s')
      ? rect.y
      : rect.y + rect.height / 2
  return { x, y }
}

/**
 * 旋转感知缩放：在节点局部坐标系完成缩放，再把结果平移回世界坐标。
 *
 * 为什么需要平移：节点旋转是绕自身中心进行的，局部缩放会改变中心；
 * 若直接提交新矩形，被拖拽的对侧锚点会在世界空间里漂移。这里先算出
 * 锚点在旧/新矩形下的世界位置差，再把整体补回去，保证「对侧不动的
 * 手感」在任意角度下都成立。
 *
 * rotation 为 0 时直接返回局部缩放结果，省掉两次旋转与锚点补偿。
 */
export function resizeRotatedRect(input: RotatedResizeInput): Rect {
  const { rect, rotation, handleId, point } = input
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }

  const localPoint = rotateAround(point, center, -rotation)
  const resized = resizeRect(rect, handleId, localPoint, {
    keepAspect: input.keepAspect,
    minSize: input.minSize,
  })
  if (rotation === 0) return resized

  const worldAnchor = rotateAround(anchorPoint(rect, handleId), center, rotation)
  const nextCenter = { x: resized.x + resized.width / 2, y: resized.y + resized.height / 2 }
  const nextWorldAnchor = rotateAround(anchorPoint(resized, handleId), nextCenter, rotation)

  const offsetX = worldAnchor.x - nextWorldAnchor.x
  const offsetY = worldAnchor.y - nextWorldAnchor.y
  return { ...resized, x: resized.x + offsetX, y: resized.y + offsetY }
}

/**
 * 组缩放：把每个节点按它在旧包围盒中的相对位置映射到新包围盒。
 *
 * 节点自身旋转保持不变；组缩放始终沿画布轴对齐方向进行（旋转感知手柄
 * 属于后续能力），这与「多选包围盒」的视觉反馈一致。
 *
 * 位置与尺寸用同一个比例，所以节点间距随组一起缩放。旧包围盒某轴为 0
 * （选中节点退化成一个点或一条线）时该轴比例取 1，只平移不缩放，避免除零
 * 产出 NaN 写进 schema。单节点尺寸另用 `MIN_NODE_SIZE` 兜底，允许小于组下限。
 */
export function scaleSelection(
  nodes: readonly SelectionNode[],
  from: Rect,
  to: Rect,
): SelectionNode[] {
  const scaleX = from.width === 0 ? 1 : to.width / from.width
  const scaleY = from.height === 0 ? 1 : to.height / from.height

  return nodes.map(({ id, rect }) => ({
    id,
    rect: {
      x: to.x + (rect.x - from.x) * scaleX,
      y: to.y + (rect.y - from.y) * scaleY,
      width: Math.max(MIN_NODE_SIZE, rect.width * scaleX),
      height: Math.max(MIN_NODE_SIZE, rect.height * scaleY),
    },
  }))
}
