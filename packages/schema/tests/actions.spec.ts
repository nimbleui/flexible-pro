import { describe, expect, it } from 'vitest'
import type { ActionDeclaration, EventConnection } from '../src/actions'
import { PAGE_EVENT_SOURCE } from '../src/actions'
import type { PageSchema } from '../src/page'
import { validateDocument } from '../src/validate'
import { SCHEMA_VERSION } from '../src/version'

function makeAction(id: string, type = 'ui.toast'): ActionDeclaration {
  return { id, type, config: {} }
}

function makeConnection(
  id: string,
  sourceNodeId: string,
  eventName: string,
  actionIds: string[] = [],
): EventConnection {
  return { id, sourceNodeId, eventName, actionIds, enabled: true }
}

function makeSchema(options: {
  actions?: Record<string, ActionDeclaration>
  connections?: Record<string, EventConnection>
}): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'root',
    nodes: {
      root: { id: 'root', componentName: 'Box' },
      button: { id: 'button', componentName: 'Button' },
    },
    components: [],
    actions: options.actions,
    connections: options.connections,
  }
}

describe('事件连接与动作校验', () => {
  it('引用完整的配置没有问题', () => {
    const schema = makeSchema({
      actions: { a1: makeAction('a1') },
      connections: {
        c1: makeConnection('c1', 'button', 'click', ['a1']),
        c2: makeConnection('c2', PAGE_EVENT_SOURCE, 'pageLoad', []),
      },
    })

    expect(validateDocument(schema)).toEqual([])
  })

  it('动作表键与自身 id 不一致时报错', () => {
    const schema = makeSchema({ actions: { wrong: makeAction('a1') } })

    expect(validateDocument(schema)).toContainEqual(
      expect.objectContaining({ severity: 'error', path: '/actions/wrong/id' }),
    )
  })

  it('动作缺少 type 时报错', () => {
    const schema = makeSchema({ actions: { a1: makeAction('a1', '') } })

    expect(validateDocument(schema)).toContainEqual(
      expect.objectContaining({ severity: 'error', path: '/actions/a1/type' }),
    )
  })

  it('连接来源节点不存在时报错，页面级哨兵不受此限制', () => {
    const schema = makeSchema({
      connections: {
        bad: makeConnection('bad', 'ghost', 'click'),
        page: makeConnection('page', PAGE_EVENT_SOURCE, 'pageLoad'),
      },
    })

    const issues = validateDocument(schema)
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: 'error', path: '/connections/bad/sourceNodeId' }),
    )
    expect(issues.some((issue) => issue.path === '/connections/page/sourceNodeId')).toBe(false)
  })

  it('连接引用不存在的动作时报错', () => {
    const schema = makeSchema({
      connections: { c1: makeConnection('c1', 'button', 'click', ['ghost']) },
    })

    expect(validateDocument(schema)).toContainEqual(
      expect.objectContaining({ severity: 'error', path: '/connections/c1/actionIds' }),
    )
  })

  it('同一节点的同一事件绑定多条连接时报错，并指出先注册的那条', () => {
    const schema = makeSchema({
      connections: {
        c1: makeConnection('c1', 'button', 'click'),
        c2: makeConnection('c2', 'button', 'click'),
      },
    })

    const issues = validateDocument(schema).filter((issue) => /绑定了同一个事件/.test(issue.message))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('c1')
  })

  it('未被任何连接引用的动作给 warning，不阻断保存', () => {
    const schema = makeSchema({ actions: { a1: makeAction('a1') } })

    const issues = validateDocument(schema).filter((issue) => issue.path === '/actions/a1')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.severity).toBe('warning')
  })
})
