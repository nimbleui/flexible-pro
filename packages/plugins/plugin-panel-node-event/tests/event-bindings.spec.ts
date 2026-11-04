import { describe, expect, it } from 'vitest'
import type { ActionDeclaration, EventConnection, EventDefinition } from '@lc/schema'
import {
  buildEventRows,
  collectEventDefinitions,
  connectionsOfNode,
  describeChain,
  issuesForConnections,
  orphanedActionIds,
  summarizeConfig,
} from '../src/utils/event-bindings'

const click: EventDefinition = { name: 'click', title: '点击' }
const change: EventDefinition = {
  name: 'change',
  title: '内容变化',
  parameters: [{ name: 'value', type: 'string' }],
}

function connection(
  id: string,
  sourceNodeId: string,
  eventName: string,
  actionIds: string[] = [],
): EventConnection {
  return { id, sourceNodeId, eventName, actionIds, enabled: true }
}

describe('collectEventDefinitions', () => {
  it('只取匹配组件名的声明，页面 schema 先写者胜出', () => {
    const components = [
      { meta: { name: 'Button' }, events: [click, { name: 'click', title: '重复声明' }] },
      { meta: { name: 'Text' }, events: [change] },
    ]

    expect(collectEventDefinitions(components, 'Button', [change])).toEqual([click, change])
    expect(collectEventDefinitions(components, 'Text')).toEqual([change])
    expect(collectEventDefinitions(components, 'Unknown')).toEqual([])
  })

  it('没有声明的组件返回空数组而不是 undefined', () => {
    expect(collectEventDefinitions([{ meta: { name: 'Box' } }], 'Box')).toEqual([])
  })
})

describe('buildEventRows', () => {
  it('未绑定的声明事件也要出现，已绑定的带上连接', () => {
    const bound = connection('c1', 'n1', 'click', ['a1'])
    const rows = buildEventRows([click, change], [bound])

    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ eventName: 'click', definition: click, connection: bound })
    expect(rows[1]).toEqual({ eventName: 'change', definition: change, connection: undefined })
  })

  it('手填的自定义事件即使没有声明也补在末尾', () => {
    const custom = connection('c2', 'n1', 'focus')
    const rows = buildEventRows([click], [connection('c1', 'n1', 'click'), custom])

    expect(rows.map((row) => row.eventName)).toEqual(['click', 'focus'])
    expect(rows[1].definition).toBeUndefined()
  })

  it('同事件的第二条连接不会造出重复行', () => {
    const rows = buildEventRows(
      [],
      [connection('c1', 'n1', 'click'), connection('c2', 'n1', 'click')],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].connection?.id).toBe('c1')
  })
})

describe('connectionsOfNode', () => {
  it('按节点过滤，其它节点与页面级连接都不进来', () => {
    const table = {
      c1: connection('c1', 'n1', 'click'),
      c2: connection('c2', 'n2', 'click'),
      c3: connection('c3', 'page', 'pageLoad'),
    }

    expect(connectionsOfNode(table, 'n1').map((item) => item.id)).toEqual(['c1'])
  })
})

describe('summarizeConfig', () => {
  const stateSet: ActionDeclaration = { id: 'a1', type: 'state.set', config: { key: 'kw' } }

  it('按内置字段声明拼摘要，缺失的字段跳过', () => {
    expect(summarizeConfig(stateSet)).toBe('变量名=kw')
    expect(summarizeConfig({ ...stateSet, config: { key: 'kw', value: '{{ n + 1 }}' } })).toBe(
      '变量名=kw · 值={{ n + 1 }}',
    )
  })

  it('表达式对象取 raw 而不是展开成 JSON', () => {
    const action: ActionDeclaration = {
      id: 'a1',
      type: 'flow.condition',
      config: { expression: { type: 'expression', raw: '{{ count > 0 }}' } },
    }

    expect(summarizeConfig(action)).toBe('条件={{ count > 0 }}')
  })

  it('自定义动作类型没有字段声明时返回空串', () => {
    expect(summarizeConfig({ id: 'a1', type: 'my.action', config: { foo: 1 } })).toBe('')
  })
})

describe('describeChain', () => {
  const actions = {
    a1: { id: 'a1', type: 'state.set', config: { key: 'kw' } },
    a2: { id: 'a2', type: 'ui.toast', name: '提示成功', config: {} },
  } satisfies Record<string, ActionDeclaration>

  it('标题优先取自定义 name，其次内置类型标题', () => {
    const steps = describeChain(actions, ['a1', 'a2'])

    expect(steps.map((step) => step.title)).toEqual(['更新状态', '提示成功'])
    expect(steps[0].summary).toBe('变量名=kw')
  })

  it('有字段声明却全未填写时写明未填写，而不是留一条看起来正常的空动作', () => {
    const empty: Record<string, ActionDeclaration> = {
      a3: { id: 'a3', type: 'flow.end', config: {} },
      a4: { id: 'a4', type: 'ui.toast', config: {} },
    }

    expect(describeChain(empty, ['a3', 'a4'])[0].summary).toBe('')
    expect(describeChain(empty, ['a3', 'a4'])[1].summary).toBe('未填写参数')
  })

  it('引用到不存在的动作时保留占位步骤，让断链看得见', () => {
    const steps = describeChain(actions, ['a9'])

    expect(steps[0]).toEqual({
      id: 'a9',
      type: '（动作已丢失）',
      title: 'a9',
      summary: '引用了不存在的动作',
    })
  })
})

describe('orphanedActionIds', () => {
  const actions = {
    a1: { id: 'a1', type: 'state.set', config: {} },
    a2: { id: 'a2', type: 'ui.toast', config: {} },
  } satisfies Record<string, ActionDeclaration>

  it('只回收没有其它连接引用的动作', () => {
    const table = {
      c1: connection('c1', 'n1', 'click', ['a1', 'a2']),
      c2: connection('c2', 'n2', 'change', ['a1']),
    }

    expect(orphanedActionIds(table, table.c1, actions)).toEqual(['a2'])
  })

  it('本面板之外的动作与不存在的引用都不回收', () => {
    const table = { c1: connection('c1', 'n1', 'click', ['a1', 'a9']) }

    expect(orphanedActionIds(table, table.c1, actions)).toEqual(['a1'])
  })
})

describe('issuesForConnections', () => {
  const actions = { a1: { id: 'a1', type: 'state.set', config: {} } }
  const list = [connection('c1', 'n1', 'click', ['a1'])]

  it('命中连接本身、其下的字段与引用动作的问题', () => {
    const issues = [
      { path: '/connections/c1', message: '重复绑定', severity: 'error' as const },
      { path: '/connections/c1/actionIds', message: '动作不存在', severity: 'error' as const },
      { path: '/actions/a1/config/key', message: '变量名未填写', severity: 'error' as const },
      { path: '/connections/c9', message: '别人的连接', severity: 'error' as const },
      { path: '/actions/a9', message: '别人的动作', severity: 'warning' as const },
      { path: '/nodes/n1/componentName', message: '与事件无关', severity: 'error' as const },
    ]

    expect(issuesForConnections(issues, list, actions).map((item) => item.path)).toEqual([
      '/connections/c1',
      '/connections/c1/actionIds',
      '/actions/a1/config/key',
    ])
  })

  it('没有连接时不产出任何问题', () => {
    expect(
      issuesForConnections(
        [{ path: '/connections/c1', message: 'x', severity: 'error' }],
        [],
        {},
      ),
    ).toEqual([])
  })
})
