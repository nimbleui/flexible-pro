import { describe, expect, it } from 'vitest'
import type { CSSProperties } from 'vue'
import type { NodeSchema, Rect } from '@lc/schema'
import type { RenderNode } from '../src/render/tree'
import { contentOriginOf, nodeStyleAt } from '../src/render/nodeStyle'

/**
 * 坐标补偿规则的回归测试。
 *
 * 这里锁的是「rect 是世界坐标、DOM 是嵌套的，所以子层必须减去父节点矩形而不是页面原点」
 * 这条口径：修复前运行时预览恒用页面原点，第三层节点每多嵌套一层就多累加一个祖先偏移，
 * 表现为「编辑时位置对、预览里偏了」。画布与预览共用 `nodeStyleAt`，规则只要在这一处漂移
 * 就会被这些断言挡住。
 */

function renderNode(id: string, rect: Rect, children: RenderNode[] = []): RenderNode {
  return {
    key: id,
    node: { id, componentName: 'Box', layout: { mode: 'absolute', rect } } as NodeSchema,
    rect,
    props: {},
    children,
    visible: true,
    disabled: false,
  }
}

/** CSSProperties 的 left/top 是 csstype 的宽类型，断言前统一读成数字像素值 */
function px(value: CSSProperties['left']): number {
  return Number(String(value).replace('px', ''))
}

/** 按两个渲染器共同的递归方式，逐层算出每个节点写入 DOM 的偏移 */
function offsetsOf(
  items: readonly RenderNode[],
  origin: { x: number; y: number },
  acc: Array<{ id: string; left: number; top: number }> = [],
): Array<{ id: string; left: number; top: number }> {
  for (const item of items) {
    const style = nodeStyleAt(item, origin)
    acc.push({ id: item.node.id, left: px(style.left), top: px(style.top) })
    offsetsOf(item.children, contentOriginOf(item), acc)
  }

  return acc
}

describe('nodeStyleAt 坐标补偿', () => {
  it('页面层的节点落在容器左上角', () => {
    const root = renderNode('root', { x: 160, y: 120, width: 520, height: 320 })
    const style = nodeStyleAt(root, { x: 160, y: 120 })

    expect(style.left).toBe('0px')
    expect(style.top).toBe('0px')
    expect(style.width).toBe('520px')
    expect(style.position).toBe('absolute')
  })

  it('子节点减去父节点矩形，而不是页面原点', () => {
    const parent = renderNode('a', { x: 200, y: 160, width: 220, height: 80 })
    const style = nodeStyleAt(
      parent,
      contentOriginOf(renderNode('root', { x: 160, y: 120, width: 520, height: 320 })),
    )

    expect(style.left).toBe('40px')
    expect(style.top).toBe('40px')
  })

  it('逐层累加的偏移等于世界矩形减页面原点', () => {
    const pageOrigin = { x: 160, y: 120 }
    const deep = renderNode('deep', { x: 240, y: 200, width: 100, height: 24 })
    const tree = [
      renderNode('root', { x: 160, y: 120, width: 520, height: 320 }, [
        renderNode('a', { x: 200, y: 160, width: 220, height: 80 }, [deep]),
      ]),
    ]

    const offsets = offsetsOf(tree, pageOrigin)
    const accumulated = offsets.reduce(
      (acc, item) => ({ x: acc.x + item.left, y: acc.y + item.top }),
      { x: 0, y: 0 },
    )

    expect(accumulated.x).toBe(deep.rect.x - pageOrigin.x)
    expect(accumulated.y).toBe(deep.rect.y - pageOrigin.y)
  })

  it('隐藏节点用 display:none 而不是移出布局', () => {
    const hidden = { ...renderNode('h', { x: 0, y: 0, width: 10, height: 10 }), visible: false }
    const style = nodeStyleAt(hidden, { x: 0, y: 0 })

    expect(style.display).toBe('none')
    expect(style.left).toBe('0px')
  })

  it('作者自持样式参与展开但不覆盖定位字段', () => {
    const item = renderNode('s', { x: 10, y: 10, width: 20, height: 20 })
    item.node.style = { color: 'red', left: '999px' } as Record<string, string>
    const style = nodeStyleAt(item, { x: 0, y: 0 })

    expect(style.color).toBe('red')
    expect(style.left).toBe('10px')
  })
})
