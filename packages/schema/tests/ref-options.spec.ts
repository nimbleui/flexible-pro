import { describe, expect, it } from 'vitest'
import type { FlowDefinition, PageSchema } from '@lc/schema'
import { DEFAULT_FLOW_SETTINGS, SCHEMA_VERSION, listRefOptions } from '@lc/schema'

/** 只填必要字段的页面骨架 */
function page(nodes: PageSchema['nodes'], rest: Partial<PageSchema> = {}): PageSchema {
  return { version: SCHEMA_VERSION, nodeId: 'root', nodes, components: [], ...rest }
}

const SCHEMA = page(
  {
    root: { id: 'root', componentName: 'Box', children: ['btn', 'plain'] },
    btn: { id: 'btn', componentName: 'Button', name: '提交按钮' },
    plain: { id: 'plain', componentName: 'Text' },
    orphan: { id: 'orphan', componentName: 'Circle' },
  },
  {
    variables: [{ name: 'count', description: '计数' }],
    datasources: [{ id: 'users', type: 'static', config: { kind: 'static', data: [] } }],
    actions: {
      'act-1': { id: 'act-1', type: 'state.set', name: '写入计数', config: {} },
      'act-2': { id: 'act-2', type: 'ui.toast', config: {} },
    },
  },
)

/** 只填必要字段的流程图；引用候选只读 id / name / description / status */
function makeFlow(id: string, name: string, status: FlowDefinition['status']): FlowDefinition {
  return {
    id,
    name,
    description: '订单审批',
    status,
    version: '1.0.0',
    updatedAt: '2026-11-01T00:00:00.000Z',
    nodes: {},
    edges: {},
    settings: { ...DEFAULT_FLOW_SETTINGS },
  }
}

describe('listRefOptions', () => {
  it('变量与数据源带上声明里的说明', () => {
    expect(listRefOptions('variable', { schema: SCHEMA })).toEqual([
      { value: 'count', label: 'count', description: '计数' },
    ])
    expect(listRefOptions('dataSource', { schema: SCHEMA })).toEqual([
      { value: 'users', label: 'users', description: 'static' },
    ])
  })

  it('动作候选优先取改名，其次取类型标题', () => {
    expect(listRefOptions('action', { schema: SCHEMA })).toEqual([
      { value: 'act-1', label: '写入计数', description: 'act-1' },
      { value: 'act-2', label: '显示消息', description: 'act-2' },
    ])
  })

  it('排除自身：分支目标不能指向包含它的动作', () => {
    const values = listRefOptions('action', { schema: SCHEMA, exclude: 'act-1' }).map(
      (option) => option.value,
    )
    expect(values).toEqual(['act-2'])
  })

  it('流程候选只列已发布的图', () => {
    /**
     * 子流程指向草稿是个不会报错的死分支：运行时匹配不到任何东西，作者只能瞎猜。
     * 页面事件的绑定下拉是另一个消费方（`listFlowBindingOptions`），它要把草稿列出来并标注，
     * 两者规则不同，所以这里过滤、那里不过滤。
     */
    const published = makeFlow('f1', '审批', 'published')
    const draft = makeFlow('f2', '还在画', 'draft')

    expect(listRefOptions('flow', { flows: [published, draft] })).toEqual([
      { value: 'f1', label: '审批', description: '订单审批' },
    ])
  })

  it('排除自身：子流程不能调自己', () => {
    const published = makeFlow('f1', '审批', 'published')
    expect(listRefOptions('flow', { flows: [published], exclude: 'f1' })).toEqual([])
  })

  it('来源需要 schema 却没传时返回空列表，不抛错', () => {
    expect(listRefOptions('variable', {})).toEqual([])
    expect(listRefOptions('action', {})).toEqual([])
    expect(listRefOptions('flow', {})).toEqual([])
  })
})
