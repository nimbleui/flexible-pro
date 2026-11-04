import { describe, expect, it } from 'vitest'
import type { NodeSchema, SlotDefinition } from '@lc/schema'
import type { RenderNode } from '../src/render/tree'
import { outletSlotNames, renderableSlots, splitSlotChildren } from '../src/render/slots'

function node(overrides: Partial<NodeSchema> = {}): NodeSchema {
  return { id: 'n1', componentName: 'Box', ...overrides }
}

function renderNode(id: string, componentName = 'Text'): RenderNode {
  return {
    key: id,
    node: node({ id, componentName }),
    rect: { x: 0, y: 0, width: 100, height: 40 },
    props: {},
    children: [],
    visible: true,
    disabled: false,
  }
}

const HEADER: SlotDefinition = { name: 'header', title: '头部' }
const BODY: SlotDefinition = { name: 'body', title: '内容' }

describe('splitSlotChildren', () => {
  it('物料没声明插槽时全部按兄弟节点渲染', () => {
    const host = node({ slots: { header: ['a'] } })
    const split = splitSlotChildren(host, [renderNode('a')], undefined)

    expect(split.named).toEqual({})
    expect(split.rest.map((item) => item.node.id)).toEqual(['a'])
  })

  it('声明过的插槽内容交给组件，children 与未声明插槽继续平铺', () => {
    const host = node({
      children: ['c1'],
      slots: { header: ['h1', 'h2'], body: ['b1'], legacy: ['l1'] },
    })
    const children = [
      renderNode('c1'),
      renderNode('h1'),
      renderNode('h2'),
      renderNode('b1'),
      renderNode('l1'),
    ]

    const split = splitSlotChildren(host, children, [HEADER, BODY])

    expect(Object.keys(split.named)).toEqual(['header', 'body'])
    expect(split.named.header?.map((item) => item.node.id)).toEqual(['h1', 'h2'])
    // legacy 是历史数据里没声明的插槽名，吞掉等于静默丢内容
    expect(split.rest.map((item) => item.node.id)).toEqual(['c1', 'l1'])
  })

  it('同一节点被写进多个插槽时只归第一个声明的槽', () => {
    const host = node({ slots: { header: ['x'], body: ['x'] } })
    const split = splitSlotChildren(host, [renderNode('x')], [HEADER, BODY])

    expect(split.named.header?.map((item) => item.node.id)).toEqual(['x'])
    expect(split.named.body).toBeUndefined()
  })
})

describe('outletSlotNames', () => {
  it('收集蓝图里插槽出口的插槽名并去重', () => {
    expect(
      outletSlotNames({
        a: node({ id: 'a', componentName: 'SlotOutlet', props: { name: 'header' } }),
        b: node({ id: 'b', componentName: 'SlotOutlet', props: { name: 'header' } }),
        c: node({ id: 'c', componentName: 'SlotOutlet', props: { name: 'body' } }),
        d: node({ id: 'd', componentName: 'Text', props: { name: 'header' } }),
      }),
    ).toEqual(['header', 'body'])
  })

  it('名字缺失或写成表达式时不计入', () => {
    expect(
      outletSlotNames({
        a: node({ id: 'a', componentName: 'SlotOutlet', props: { name: '' } }),
        b: node({
          id: 'b',
          componentName: 'SlotOutlet',
          props: { name: { type: 'expression', raw: '{{ slotName }}' } },
        }),
      }),
    ).toEqual([])
  })
})

describe('renderableSlots', () => {
  it('组件没放任何出口时全部内容照旧渲染', () => {
    expect(renderableSlots([], ['header', 'body'])).toEqual(['header', 'body'])
  })

  it('有出口就只渲染有出口的插槽，忘记放出口的内容不会显示', () => {
    expect(renderableSlots(['header'], ['header', 'body'])).toEqual(['header'])
  })
})
