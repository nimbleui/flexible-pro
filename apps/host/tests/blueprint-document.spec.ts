import { describe, expect, it } from 'vitest'
import type { ComponentSchema, NodeSchema, PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import {
  blueprintDocumentId,
  blueprintSchemaOf,
  contentBounds,
  createBlueprintNodes,
  definitionFromBlueprint,
  initialComponentSchema,
} from '../src/custom-components/blueprint-document'

const META: ComponentSchema['meta'] = {
  name: 'ScoreCard',
  title: '评分卡',
  group: '自定义',
  version: '1.0.0',
}

function node(overrides: Partial<NodeSchema> = {}): NodeSchema {
  return {
    id: 'root',
    componentName: 'Box',
    layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 360, height: 240 } },
    ...overrides,
  }
}

function definition(nodes: Record<string, NodeSchema>, nodeId = 'root'): ComponentSchema {
  return { meta: META, nodeId, nodes }
}

describe('蓝图文档标识', () => {
  it('与页面文档分属不同命名空间', () => {
    expect(blueprintDocumentId('cc-1')).toBe('component-blueprint:cc-1')
  })

  it('新建落库的定义带起始根容器，能通过保存校验', () => {
    const definition = initialComponentSchema(
      META,
      [{ name: 'v', title: '值', type: 'string' }],
      [],
    )

    expect(definition.nodes[definition.nodeId]).toBeDefined()
    expect(definition.defaultProps).toBeUndefined()
    expect(definition.props).toHaveLength(1)
  })

  it('事件声明随定义落库', () => {
    const definition = initialComponentSchema(
      META,
      [],
      [{ name: 'click', title: '点击', parameters: [{ name: 'id', type: 'string' }] }],
    )

    expect(definition.events).toEqual([
      { name: 'click', title: '点击', parameters: [{ name: 'id', type: 'string' }] },
    ])
  })
})

describe('定义 → 画布文档', () => {
  it('起始蓝图只有一个根容器', () => {
    expect(createBlueprintNodes()).toEqual({
      root: {
        id: 'root',
        componentName: 'Box',
        layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 360, height: 240 } },
      },
    })
  })

  it('文档骨架带齐画布需要的页面字段', () => {
    const schema = blueprintSchemaOf(undefined, 'component-blueprint:new')

    expect(schema.version).toBe(SCHEMA_VERSION)
    expect(schema.components).toEqual([])
    expect(schema.metadata).toEqual({ title: 'component-blueprint:new' })
    expect(schema.nodeId).toBe('root')
  })

  it('节点整体深拷贝并加 id 命名空间，画布里的中间态不会漏回定义', () => {
    const source = definition({ root: node({ props: { label: '评分' } }) })
    const schema = blueprintSchemaOf(source, 'doc')

    expect(schema.nodes).not.toBe(source.nodes)
    expect(schema.nodes['bp-root']).not.toBe(source.nodes.root)
    expect(schema.nodeId).toBe('bp-root')

    const child = schema.nodes['bp-root'] as NodeSchema
    child.props = { label: '改了' }
    expect(source.nodes.root?.props).toEqual({ label: '评分' })
  })

  it('父子引用一起改名，且不与本次会话新分配的 node-1 相撞', () => {
    const schema = blueprintSchemaOf(
      definition({
        root: node({ children: ['node-1'] }),
        'node-1': node({ id: 'node-1', componentName: 'Text' }),
      }),
      'doc',
    )

    expect(schema.nodes['bp-root']?.children).toEqual(['bp-node-1'])
    expect(Object.keys(schema.nodes).sort()).toEqual(['bp-node-1', 'bp-root'])

    // 二次进入：已经带前缀的 id 不再重复加
    const again = blueprintSchemaOf(
      { meta: META, nodeId: schema.nodeId, nodes: schema.nodes },
      'doc',
    )
    expect(again.nodeId).toBe('bp-root')
    expect(again.nodes['bp-root']?.children).toEqual(['bp-node-1'])
  })

  it('根 id 失效时按第一个节点兜底，全空才建新根', () => {
    expect(
      blueprintSchemaOf(definition({ a: node({ id: 'a' }) }, 'missing'), 'doc').nodeId,
    ).toBe('bp-a')

    const rebuilt = blueprintSchemaOf(definition({}, 'missing'), 'doc')
    expect(rebuilt.nodeId).toBe('root')
    expect(Object.keys(rebuilt.nodes)).toEqual(['root'])
  })
})

describe('画布文档 → 定义', () => {
  /** 画布会写入的字段一个都不能在合成时丢掉，否则「摆好的样子」刷新即变形 */
  it('保留布局、样式与图层开关', () => {
    const schema: PageSchema = {
      version: SCHEMA_VERSION,
      nodeId: 'root',
      nodes: {
        root: node(),
        label: node({
          id: 'label',
          componentName: 'Text',
          name: '标题文本',
          hidden: true,
          locked: true,
          props: { text: { type: 'expression', raw: '{{ props.label }}' } },
          layout: {
            mode: 'absolute',
            rect: { x: 8, y: 12, width: 120, height: 24 },
            rotate: 15,
            zIndex: 3,
          },
          style: { padding: '4px', opacity: 0.8 },
          children: undefined,
        }),
      },
      components: [],
      metadata: { title: 'doc' },
    }

    const result = definitionFromBlueprint(schema, META, [
      { name: 'label', title: '标题', type: 'string', defaultValue: '评分' },
    ])

    expect(result.nodeId).toBe('root')
    expect(result.nodes.label).toEqual({
      id: 'label',
      componentName: 'Text',
      name: '标题文本',
      hidden: true,
      locked: true,
      props: { text: { type: 'expression', raw: '{{ props.label }}' } },
      layout: {
        mode: 'absolute',
        rect: { x: 8, y: 12, width: 120, height: 24 },
        rotate: 15,
        zIndex: 3,
      },
      style: { padding: '4px', opacity: 0.8 },
    })
    expect(result.defaultProps).toEqual({ label: '评分' })
    expect(result.props).toHaveLength(1)
  })

  it('没有对外属性时不落 props 字段', () => {
    const schema: PageSchema = {
      version: SCHEMA_VERSION,
      nodeId: 'root',
      nodes: { root: node() },
      components: [],
      metadata: { title: 'doc' },
    }

    const result = definitionFromBlueprint(schema, META, [])

    expect(result.props).toBeUndefined()
    expect(result.defaultProps).toBeUndefined()
  })

  it('合成的定义与文档快照脱钩', () => {
    const schema: PageSchema = {
      version: SCHEMA_VERSION,
      nodeId: 'root',
      nodes: { root: node() },
      components: [],
      metadata: { title: 'doc' },
    }

    const result = definitionFromBlueprint(schema, META, [])
    ;(schema.nodes.root as NodeSchema).componentName = 'Circle'
    expect(result.nodes.root?.componentName).toBe('Box')
  })
})

describe('蓝图包围盒', () => {
  it('取所有绝对定位节点矩形的并集', () => {
    expect(
      contentBounds({
        a: node({
          id: 'a',
          layout: { mode: 'absolute', rect: { x: 10, y: 20, width: 100, height: 40 } },
        }),
        b: node({
          id: 'b',
          layout: { mode: 'absolute', rect: { x: 0, y: 80, width: 20, height: 20 } },
        }),
      }),
    ).toEqual({ x: 0, y: 20, width: 110, height: 80 })
  })

  it('没有可用几何时给出兜底尺寸', () => {
    expect(contentBounds({ c: { id: 'c', componentName: 'Box' } })).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 200,
    })
  })
})
