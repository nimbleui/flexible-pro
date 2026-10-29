import type { NodeSchema } from '../src/node'
import type { PageSchema } from '../src/page'
import type { SchemaPatch } from '../src/patch'
import type { Rect } from '../src/styles'
import { applyPatches } from '../src/patch'
import { SCHEMA_VERSION } from '../src/version'
import { describe, expect, it } from 'vitest'
import {
  buildOutlineTree,
  changeOrders,
  groupNodes,
  paintOrder,
  reorderChildren,
  renameNode,
  setNodeFlags,
  ungroupNodes,
} from '../src/tree'

/** 只给结构测试需要的字段，rect 用可覆盖的默认值 */
function node(id: string, extra: Partial<NodeSchema> = {}): NodeSchema {
  return {
    id,
    componentName: 'Box',
    layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 100, height: 40 } },
    ...extra,
  }
}

function page(nodes: NodeSchema[], nodeId = 'root'): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId,
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    components: [],
  }
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height }
}

/** 把 patch 应用一遍，让断言落在「文档变成什么样」而不是字符串路径上 */
function apply(schema: PageSchema, patches: SchemaPatch[]): PageSchema {
  return applyPatches(schema, patches)
}

describe('图层树构建', () => {
  it('children 在前、插槽在后，并记录父级位置', () => {
    const schema = page([
      node('root', { children: ['a', 'b'], slots: { header: ['c'] } }),
      node('a', { children: ['d'] }),
      node('b'),
      node('c'),
      node('d'),
    ])

    const [root] = buildOutlineTree(schema)
    expect(root?.node.id).toBe('root')
    expect(root?.position).toBeUndefined()
    expect(root?.children.map((item) => item.node.id)).toEqual(['a', 'b', 'c'])
    expect(root?.children[0]?.position).toEqual({ parentId: 'root', index: 0 })
    expect(root?.children[2]?.position).toEqual({ parentId: 'root', slot: 'header', index: 0 })
    expect(root?.children[0]?.children[0]?.node.id).toBe('d')
  })

  it('游离节点作为顶层条目补在末尾', () => {
    const schema = page([node('root', { children: ['a'] }), node('a'), node('orphan')])

    expect(buildOutlineTree(schema).map((item) => item.node.id)).toEqual(['root', 'orphan'])
  })

  it('绘制顺序按深度优先，隐藏节点连同子树一起排除', () => {
    const schema = page([
      node('root', { children: ['a', 'b'] }),
      node('a', { children: ['a1'] }),
      node('a1'),
      node('b', { hidden: true, children: ['b1'] }),
      node('b1'),
    ])

    expect(paintOrder(schema)).toEqual(['root', 'a', 'a1'])
  })
})

describe('同父排序与层级调整', () => {
  const schema = page([
    node('root', { children: ['a', 'b', 'c'] }),
    node('a'),
    node('b'),
    node('c'),
  ])

  it('reorderChildren 按下标「先移除再插入」重排', () => {
    const next = apply(schema, reorderChildren(schema, { parentId: 'root', from: 0, to: 2 }))
    expect(next.nodes.root?.children).toEqual(['b', 'c', 'a'])
  })

  it('reorderChildren 下标越界时不写任何 patch', () => {
    expect(reorderChildren(schema, { parentId: 'root', from: 0, to: 9 })).toEqual([])
    expect(reorderChildren(schema, { parentId: 'gone', from: 0, to: 1 })).toEqual([])
  })

  it('changeOrders 的四种方位都朝「数组末尾 = 上层」移动', () => {
    expect(apply(schema, changeOrders(schema, ['b'], 'front')).nodes.root?.children).toEqual([
      'a',
      'c',
      'b',
    ])
    expect(apply(schema, changeOrders(schema, ['b'], 'back')).nodes.root?.children).toEqual([
      'b',
      'a',
      'c',
    ])
    expect(apply(schema, changeOrders(schema, ['a'], 'forward')).nodes.root?.children).toEqual([
      'b',
      'a',
      'c',
    ])
    expect(apply(schema, changeOrders(schema, ['c'], 'backward')).nodes.root?.children).toEqual(
      ['a', 'c', 'b'],
    )
  })

  it('多选移动整块生效，相邻的选中节点之间不互相抢位', () => {
    expect(
      apply(schema, changeOrders(schema, ['a', 'b'], 'front')).nodes.root?.children,
    ).toEqual(['c', 'a', 'b'])
    expect(
      apply(schema, changeOrders(schema, ['a', 'b'], 'backward')).nodes.root?.children,
    ).toEqual(['a', 'b', 'c'])
    expect(
      apply(schema, changeOrders(schema, ['b', 'c'], 'forward')).nodes.root?.children,
    ).toEqual(['a', 'b', 'c'])
  })

  it('已经在边界或不在树里时不产生 patch', () => {
    expect(changeOrders(schema, ['c'], 'front')).toEqual([])
    expect(changeOrders(schema, ['a'], 'back')).toEqual([])
    expect(changeOrders(schema, ['root'], 'front')).toEqual([])
    expect(changeOrders(schema, [], 'front')).toEqual([])
  })
})

describe('组合与解组', () => {
  const spread = page([
    node('root', { children: ['a', 'b', 'c'] }),
    node('a', { layout: { mode: 'absolute', rect: rect(0, 0, 100, 40) } }),
    node('b', { layout: { mode: 'absolute', rect: rect(200, 100, 80, 60) } }),
    node('c', { layout: { mode: 'absolute', rect: rect(400, 400, 50, 50) } }),
  ])

  it('新组落在第一个成员原来的位置，成员矩形并集成为组的几何', () => {
    const result = groupNodes(spread, ['b', 'a'], { createId: () => 'g1' })
    const next = apply(spread, result?.patches ?? [])

    expect(result?.groupId).toBe('g1')
    expect(next.nodes.root?.children).toEqual(['g1', 'c'])
    expect(next.nodes.g1?.children).toEqual(['b', 'a'])
    expect(next.nodes.g1?.layout?.rect).toEqual(rect(0, 0, 280, 160))
    // 成员几何是世界坐标，换父级不改变位置
    expect(next.nodes.b?.layout?.rect).toEqual(rect(200, 100, 80, 60))
  })

  it('已随父级进组的后代不重复列为组成员', () => {
    const nested = page([
      node('root', { children: ['box', 'y'] }),
      node('box', { children: ['x'] }),
      node('x', { layout: { mode: 'absolute', rect: rect(10, 10, 20, 20) } }),
      node('y', { layout: { mode: 'absolute', rect: rect(50, 50, 20, 20) } }),
    ])

    const result = groupNodes(nested, ['box', 'x', 'y'], { createId: () => 'g1' })
    const next = apply(nested, result?.patches ?? [])

    expect(next.nodes.g1?.children).toEqual(['box', 'y'])
    expect(next.nodes.box?.children).toEqual(['x'])
    expect(next.nodes.root?.children).toEqual(['g1'])
  })

  it('少于两个成员不分组', () => {
    expect(groupNodes(spread, ['a'], { createId: () => 'g1' })).toBeUndefined()
    expect(groupNodes(spread, ['root', 'a'], { createId: () => 'g1' })).toBeUndefined()
  })

  it('解组把成员放回组原来的位置并删除组节点', () => {
    const grouped = page([
      node('root', { children: ['g', 'c'] }),
      node('g', { componentName: 'Group', children: ['a', 'b'] }),
      node('a'),
      node('b'),
      node('c'),
    ])

    const next = apply(grouped, ungroupNodes(grouped, ['g']))
    expect(next.nodes.root?.children).toEqual(['a', 'b', 'c'])
    expect(next.nodes.g).toBeUndefined()
  })
})

describe('显隐锁定与重命名', () => {
  const schema = page([node('root', { children: ['a', 'b'] }), node('a'), node('b')])

  it('一次写入多个开关，缺失字段用 replace 补上', () => {
    const next = apply(
      schema,
      setNodeFlags(schema, ['a', 'b'], { hidden: true, locked: false }),
    )
    expect(next.nodes.a?.hidden).toBe(true)
    expect(next.nodes.a?.locked).toBe(false)
    expect(next.nodes.b?.hidden).toBe(true)
  })

  it('重命名写入去空格后的名字，空名字删除字段回到组件名', () => {
    expect(apply(schema, renameNode(schema, 'a', '  标题  ')).nodes.a?.name).toBe('标题')
    expect(apply(schema, renameNode(schema, 'a', '   ')).nodes.a?.name).toBeUndefined()
  })
})
