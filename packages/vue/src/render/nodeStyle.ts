import type { CSSProperties } from 'vue'
import type { Point } from '@lc/contracts'
import type { RenderNode } from './tree'

/**
 * 子节点的补偿原点：父节点自己的世界矩形左上角。
 *
 * schema 里的 `rect` 始终是世界坐标，而节点 wrapper 是嵌套 DOM，所以子节点要减去
 * **父节点**的原点，不是页面根节点的原点。减错一层不会报错，只会让视觉位置多出一个
 * 祖先的偏移量——画布与运行时预览曾经各写一套这个逻辑，预览漏传 origin 就出现了
 * 「编辑与预览位置不一致」。口径放在渲染层共用，与 `render/slots.ts` 同一个理由。
 */
export function contentOriginOf(item: RenderNode): Point {
  return { x: item.rect.x, y: item.rect.y }
}

/**
 * 节点的绝对定位样式。
 *
 * `origin` 是当前 DOM 层的坐标原点（页面层传根节点矩形，容器内部传该容器的矩形）；
 * 节点自持的 `style` 先展开，保证定位字段不被作者样式覆盖。
 *
 * @param item 已求值的渲染节点
 * @param origin 当前层的坐标原点
 */
export function nodeStyleAt(item: RenderNode, origin: Point): CSSProperties {
  const rect = item.rect

  return {
    ...(item.node.style as CSSProperties | undefined),
    position: 'absolute',
    left: `${rect.x - origin.x}px`,
    top: `${rect.y - origin.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    zIndex: item.node.layout?.zIndex,
    transform: item.node.layout?.rotate ? `rotate(${item.node.layout.rotate}deg)` : undefined,
    display: item.visible ? undefined : 'none',
  }
}
