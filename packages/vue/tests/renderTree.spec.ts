import type { NodeSchema, PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import { describe, expect, it } from 'vitest'
import { buildRenderTree } from '../src/render/tree'

function expression(raw: string): { type: 'expression'; raw: string } {
  return { type: 'expression', raw }
}

function node(id: string, extra: Partial<NodeSchema> = {}): NodeSchema {
  return {
    id,
    componentName: 'Box',
    layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 100, height: 40 } },
    ...extra,
  } as NodeSchema
}

function createSchema(nodes: Record<string, NodeSchema>): PageSchema {
  return { version: SCHEMA_VERSION, nodeId: 'root', nodes, components: [] }
}

const resolveValue = (value: unknown, scope: Record<string, unknown>): unknown => {
  if (
    value &&
    typeof value === 'object' &&
    (value as { type?: string }).type === 'expression'
  ) {
    return scope[(value as { raw: string }).raw]
  }
  return value
}

describe('渲染树', () => {
  it('条件为假的节点与子树不渲染', () => {
    const schema = createSchema({
      root: node('root', { children: ['a', 'b'] }),
      a: node('a', { condition: expression('showA'), children: ['c'] }),
      b: node('b'),
      c: node('c'),
    })

    const tree = buildRenderTree({ schema, resolveValue, scope: { showA: false } })
    const rootChildren = tree[0]?.children.map((child) => child.node.id)
    expect(rootChildren).toEqual(['b'])
  })

  it('hidden 节点连同子树不进入渲染树', () => {
    const schema = createSchema({
      root: node('root', { children: ['a', 'b'] }),
      a: node('a', { hidden: true, children: ['c'] }),
      b: node('b'),
      c: node('c'),
    })

    const tree = buildRenderTree({ schema, resolveValue, scope: {} })
    expect(tree[0]?.children.map((child) => child.node.id)).toEqual(['b'])
  })

  it('hide 指令只影响可见性，不移除节点', () => {
    const schema = createSchema({
      root: node('root', { children: ['a'] }),
      a: node('a', { directives: [{ type: 'hide', condition: expression('hideA') }] }),
    })

    const tree = buildRenderTree({ schema, resolveValue, scope: { hideA: true } })
    expect(tree[0]?.children[0]?.visible).toBe(false)
  })

  it('循环展开为多个实例并注入 item/index 作用域', () => {
    const schema = createSchema({
      root: node('root', { children: ['a', 'item'] }),
      a: node('a'),
      item: node('item', {
        loop: { dataSource: expression('items'), itemName: 'item', indexName: 'index' },
        props: { label: expression('item') },
      }),
    })

    const tree = buildRenderTree({ schema, resolveValue, scope: { items: ['x', 'y'] } })
    const instances = tree[0]?.children.filter((child) => child.node.id === 'item') ?? []

    expect(instances.map((child) => child.key)).toEqual(['root/item#0', 'root/item#1'])
    expect(instances.map((child) => child.props.label)).toEqual(['x', 'y'])
  })

  it('children 与 slots 内容合并渲染，嵌套关系保留', () => {
    const schema = createSchema({
      root: node('root', { children: ['a'] }),
      a: node('a', { children: ['c'], slots: { footer: ['d'] } }),
      c: node('c'),
      d: node('d'),
    })

    const tree = buildRenderTree({ schema, resolveValue })
    const a = tree[0]?.children[0]
    expect(a?.children.map((child) => child.node.id)).toEqual(['c', 'd'])
    expect(a?.children[0]?.rect).toEqual({ x: 0, y: 0, width: 100, height: 40 })
  })

  it('未被引用的节点作为顶层孤儿渲染', () => {
    const schema = createSchema({
      root: node('root'),
      orphan: node('orphan'),
    })

    const tree = buildRenderTree({ schema, resolveValue })
    expect(tree.map((item) => item.node.id)).toEqual(['root', 'orphan'])
  })
})
