import type { NodeSchema, PageSchema } from '@lc/schema'
import { createExpression, SCHEMA_VERSION } from '@lc/schema'
import { createExpressionEngine } from '@lc/expression'
import { describe, expect, it } from 'vitest'
import { buildRenderTree } from '../src/render/tree'

/**
 * 渲染树 × 真实表达式引擎的接线测试。
 *
 * `renderTree.spec.ts` 用的是注入的假 `resolveValue`，只验证树形规则；
 * 本文件验证的是宿主真正交付的那条链路：`expression.resolveValue` 直接作为
 * 求值入口注入（见 `CanvasStage.vue`），因此表达式语义、类型保留与
 * 页面声明函数都必须在这条链路上成立。
 */

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

describe('渲染树使用真实引擎求值', () => {
  it('props 里的表达式保留类型，模板字符串插值，嵌套对象递归', () => {
    const engine = createExpressionEngine()
    const tree = buildRenderTree({
      schema: createSchema({
        root: node('root', { children: ['card'] }),
        card: node('card', {
          props: {
            count: createExpression('{{ n * 2 }}'),
            title: '共 {{ n }} 项',
            style: { size: createExpression('{{ n }}'), name: '静态' },
          },
        }),
      }),
      resolveValue: engine.resolveValue,
      scope: { n: 3 },
    })

    expect(tree[0]?.children[0]?.props).toEqual({
      count: 6,
      title: '共 3 项',
      style: { size: 3, name: '静态' },
    })
  })

  it('condition 与循环数据源走同一入口，逐实例注入 item 作用域', () => {
    const engine = createExpressionEngine()
    const tree = buildRenderTree({
      schema: createSchema({
        root: node('root', { children: ['hiddenNode', 'item'] }),
        hiddenNode: node('hiddenNode', { condition: createExpression('{{ blocked }}') }),
        item: node('item', {
          loop: { dataSource: createExpression('{{ rows }}'), itemName: 'row', indexName: 'i' },
          props: { label: createExpression('{{ row.name + "#" + i }}') },
        }),
      }),
      resolveValue: engine.resolveValue,
      scope: { blocked: false, rows: [{ name: 'A' }, { name: 'B' }] },
    })

    const ids = tree[0]?.children.map((child) => child.node.id)
    expect(ids).toEqual(['item', 'item'])
    expect(tree[0]?.children.map((child) => child.props.label)).toEqual(['A#0', 'B#1'])
  })

  it('页面声明的自定义函数在渲染求值中生效', () => {
    const engine = createExpressionEngine()
    const schema = createSchema({
      root: node('root', { children: ['bar'] }),
      bar: node('bar', { props: { text: createExpression('{{ progress(todos) }}') } }),
    })

    // 宿主在装载文档时注册页面级函数；这里模拟该动作
    engine.functions.registerAll(
      [
        {
          name: 'progress',
          params: ['list'],
          body: "list.filter(t => t.done).length + ' / ' + list.length",
        },
      ],
      'page',
    )

    const todos = [{ done: true }, { done: false }]
    const tree = buildRenderTree({
      schema,
      resolveValue: engine.resolveValue,
      scope: { todos },
    })

    expect(tree[0]?.children[0]?.props.text).toBe('1 / 2')
  })
})
