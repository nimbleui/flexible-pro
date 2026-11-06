import { describe, expect, it } from 'vitest'
import type { NodeSchema, PageSchema } from '@lc/schema'
import { SCHEMA_VERSION, createExpression } from '@lc/schema'
import {
  bindingsReferencing,
  findUnresolvedRefs,
  findUnusedData,
  scanPageBindings,
} from '../src/data-binding/utils/binding-scan'
import { listDataItems } from '../src/data-binding/utils/data-items'

/** 只填必要字段的页面骨架；具体用例再往里塞节点与声明 */
function pageSchema(
  nodes: Record<string, NodeSchema>,
  rest: Partial<PageSchema> = {},
): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'root',
    nodes,
    components: [],
    ...rest,
  }
}

const ROOT: NodeSchema = {
  id: 'root',
  componentName: 'Box',
  children: ['a', 'b'],
}

/** 不参与断言的占位节点：让 root 的 children 都能解析到真实节点，而不是引用到 root 自己 */
function leaf(id: string): NodeSchema {
  return { id, componentName: 'Box' }
}

describe('scanPageBindings', () => {
  it('整值绑定与混排插值都算一条绑定', () => {
    const schema = pageSchema({
      root: ROOT,
      a: { id: 'a', componentName: 'Text', props: { text: createExpression('{{ data.t }}') } },
      b: { id: 'b', componentName: 'Text', props: { text: '共 {{ data.n }} 项' } },
    })

    const bindings = scanPageBindings(schema)
    expect(bindings).toHaveLength(2)
    expect(bindings[0]).toMatchObject({
      nodeId: 'a',
      nodeLabel: 'Text',
      field: 'props.text',
      kind: 'prop',
      mode: 'expression',
      refs: [{ root: 'data', path: 'data.t', dynamic: false }],
    })
    expect(bindings[1]?.mode).toBe('template')
  })

  it('条件、循环、指令、样式与键值各自成一条', () => {
    const schema = pageSchema({
      root: ROOT,
      a: {
        id: 'a',
        componentName: 'Box',
        condition: createExpression('{{ data.visible }}'),
        loop: { dataSource: createExpression('{{ data.rows }}'), itemName: 'row' },
        directives: [{ type: 'show', condition: createExpression('{{ data.ok }}') }],
        style: { color: '{{ data.color }}' },
        key: '{{ row.id }}',
      },
      b: leaf('b'),
    })

    const fields = scanPageBindings(schema).map((binding) => binding.field)
    expect(fields).toEqual([
      'condition',
      'loop.dataSource',
      'directives[0].condition',
      'style.color',
      'key',
    ])
  })

  it('数组与对象属性按渲染器的递归规则展开到叶子', () => {
    const schema = pageSchema({
      root: ROOT,
      a: {
        id: 'a',
        componentName: 'Box',
        props: {
          columns: [{ title: '{{ data.head }}' }],
          meta: { owner: { id: '{{ data.uid }}' } },
        },
      },
      b: leaf('b'),
    })

    expect(scanPageBindings(schema).map((binding) => binding.field)).toEqual([
      'props.columns[0].title',
      'props.meta.owner.id',
    ])
  })

  it('固定值与空表达式不产生绑定', () => {
    const schema = pageSchema({
      root: ROOT,
      a: { id: 'a', componentName: 'Text', props: { text: '标题', empty: '', list: [1, 2] } },
      b: leaf('b'),
    })

    expect(scanPageBindings(schema)).toEqual([])
  })

  it('原生 JS 片段标记为 unsafe 且不产出引用', () => {
    const schema = pageSchema({
      root: ROOT,
      a: {
        id: 'a',
        componentName: 'Text',
        props: { text: { type: 'js', code: 'Math.max(1, 2)' } },
      },
      b: leaf('b'),
    })

    const [binding] = scanPageBindings(schema)
    expect(binding).toMatchObject({ unsafe: true, expression: 'Math.max(1, 2)' })
    expect(binding?.refs).toEqual([])
  })

  it('按渲染顺序排列，具名插槽内容紧跟宿主节点，游离节点补在最后', () => {
    const schema = pageSchema({
      root: { id: 'root', componentName: 'Box', children: ['a'], slots: { header: ['h'] } },
      a: { id: 'a', componentName: 'Text', props: { text: '{{ data.a }}' } },
      h: { id: 'h', componentName: 'Text', props: { text: '{{ data.h }}' } },
      orphan: { id: 'orphan', componentName: 'Text', props: { text: '{{ data.o }}' } },
    })

    expect(scanPageBindings(schema).map((binding) => binding.nodeId)).toEqual([
      'a',
      'h',
      'orphan',
    ])
  })

  it('节点展示名优先取 name', () => {
    const schema = pageSchema({
      root: ROOT,
      a: { id: 'a', componentName: 'Text', name: '标题文本', props: { text: '{{ data.t }}' } },
      b: leaf('b'),
    })

    expect(scanPageBindings(schema)[0]?.nodeLabel).toBe('标题文本')
  })

  it('动作 config 与 condition 计入引用，避免把事件里在用的数据报成死数据', () => {
    const schema = pageSchema(
      { root: ROOT, a: leaf('a'), b: leaf('b') },
      {
        actions: {
          'act-1': {
            id: 'act-1',
            type: 'state.set',
            name: '写入计数',
            config: { value: '{{ data.count }}' },
            condition: createExpression('{{ data.ready }}'),
          },
        },
        variables: [{ name: 'count' }, { name: 'ready' }],
      },
    )

    const bindings = scanPageBindings(schema)
    expect(bindings.map((binding) => binding.field)).toEqual([
      'actions[act-1].config.value',
      'actions[act-1].condition',
    ])
    expect(bindings[0]?.nodeLabel).toBe('写入计数')
    expect(findUnusedData(bindings, schema)).toEqual([])
  })
})

describe('引用分析', () => {
  const schema = pageSchema(
    {
      root: ROOT,
      a: { id: 'a', componentName: 'Text', props: { text: '{{ data.users.data[0].name }}' } },
      b: { id: 'b', componentName: 'Text', props: { label: '{{ data.token }}' } },
    },
    {
      variables: [{ name: 'count' }],
      datasources: [{ id: 'users', type: 'static', config: { kind: 'static', data: [] } }],
    },
  )
  const bindings = scanPageBindings(schema)

  it('按路径前缀匹配引用，同名前缀不误判', () => {
    expect(bindingsReferencing(bindings, 'data.users')).toHaveLength(1)
    expect(bindingsReferencing(bindings, 'data.token')).toHaveLength(1)
    expect(bindingsReferencing(bindings, 'data.user')).toHaveLength(0)
  })

  it('报出引用了未声明数据项的绑定', () => {
    const issues = findUnresolvedRefs(bindings, schema)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ name: 'token', path: 'data.token' })
    expect(issues[0]?.binding.nodeId).toBe('b')
  })

  it('列出没有任何绑定读取的数据项', () => {
    expect(findUnusedData(bindings, schema)).toEqual([{ name: 'count', kind: 'variable' }])
  })

  it('出现动态 data 下标时整体跳过死数据检查', () => {
    const dynamic = pageSchema({
      root: ROOT,
      a: { id: 'a', componentName: 'Text', props: { text: '{{ data[key] }}' } },
      b: leaf('b'),
    })
    const dynamicBindings = scanPageBindings(dynamic)

    expect(dynamicBindings[0]?.refs).toEqual([
      { root: 'data', path: 'data', dynamic: true },
      { root: 'key', path: 'key', dynamic: false },
    ])
    expect(findUnusedData(dynamicBindings, dynamic)).toEqual([])
  })
})

describe('listDataItems', () => {
  it('四组数据项按变量、接口数据、函数、路由的顺序产出', () => {
    const schema = pageSchema(
      { root: ROOT, a: leaf('a'), b: leaf('b') },
      {
        variables: [{ name: 'count', type: { kind: 'number' }, defaultValue: 3 }],
        datasources: [
          {
            id: 'users',
            type: 'rest',
            config: { kind: 'rest', url: '/api/users' },
            resultType: {
              kind: 'array',
              item: { kind: 'object', fields: { id: { kind: 'string' } } },
            },
          },
        ],
        functions: [{ name: 'progress', params: ['list'], body: 'list.length' }],
        route: { params: [{ name: 'id', description: '用户 ID' }] },
      },
    )

    expect(listDataItems(schema)).toEqual([
      {
        kind: 'variable',
        name: 'count',
        path: 'data.count',
        detail: 'number',
        description: undefined,
      },
      {
        kind: 'source',
        name: 'users',
        path: 'data.users',
        detail: 'REST 接口 · object{1}[]',
        description: undefined,
      },
      {
        kind: 'function',
        name: 'progress',
        path: 'progress',
        detail: 'progress(list)',
        description: undefined,
      },
      {
        kind: 'route',
        name: 'id',
        path: '$params.id',
        detail: '$params',
        description: '用户 ID',
      },
    ])
  })

  it('没写类型标注的变量按默认值推类型', () => {
    const schema = pageSchema(
      { root: ROOT, a: leaf('a'), b: leaf('b') },
      {
        variables: [
          { name: 'rows', defaultValue: [{ id: 1 }] },
          { name: 'flag', defaultValue: true },
        ],
      },
    )

    expect(listDataItems(schema).map((item) => item.detail)).toEqual(['1 项', 'boolean'])
  })
})
