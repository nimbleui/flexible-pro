import { describe, expect, it } from 'vitest'
import type { ActionDeclaration, EventConnection } from '../src/actions'
import { PAGE_EVENT_SOURCE, referencedActionIds } from '../src/actions'
import { createExpression } from '../src/expression'
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

    const issues = validateDocument(schema).filter((issue) =>
      /绑定了同一个事件/.test(issue.message),
    )
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

/** 控制流动作：条件一律写成表达式对象，避免条件形态的报错混进环检测用例 */
function makeFlowAction(
  id: string,
  type: string,
  config: Record<string, unknown> = {},
): ActionDeclaration {
  return { id, type, config: { expression: createExpression('{{ ok }}'), ...config } }
}

describe('动作之间的引用', () => {
  it('三个引用来源都能被提取：分支目标、序列成员、补救动作', () => {
    const condition = makeFlowAction('gate', 'flow.condition', {
      trueActionId: 'yes',
      falseActionId: 'no',
    })
    const sequence = makeFlowAction('group', 'flow.sequence', { actionIds: ['x', 'y'] })
    const fallback = {
      ...makeAction('risky'),
      onError: 'fallback' as const,
      fallbackActionId: 'rescue',
    }

    expect(referencedActionIds(condition)).toEqual(['yes', 'no'])
    expect(referencedActionIds(sequence)).toEqual(['x', 'y'])
    expect(referencedActionIds(fallback)).toEqual(['rescue'])
  })

  it('非字符串的成员被忽略而不是报错，形状问题归字段校验', () => {
    const sequence = makeFlowAction('group', 'flow.sequence', {
      actionIds: ['x', 42, null, '', 'y'],
    })

    expect(referencedActionIds(sequence)).toEqual(['x', 'y'])
  })

  it('普通动作没有引用；fallback 策略之外的 fallbackActionId 不算引用', () => {
    const plain = makeAction('a1')
    const ignored = { ...makeAction('a2'), onError: 'stop' as const, fallbackActionId: 'ghost' }

    expect(referencedActionIds(plain)).toEqual([])
    expect(referencedActionIds(ignored)).toEqual([])
  })

  it('分支目标指向不存在的动作时报错', () => {
    const schema = makeSchema({
      actions: {
        gate: makeFlowAction('gate', 'flow.condition', { trueActionId: 'ghost' }),
      },
      connections: { c1: makeConnection('c1', 'button', 'click', ['gate']) },
    })

    expect(validateDocument(schema)).toContainEqual(
      expect.objectContaining({ severity: 'error', message: '引用的动作 "ghost" 不存在' }),
    )
  })

  it('只被 flow.sequence 引用的动作不算孤儿', () => {
    const schema = makeSchema({
      actions: {
        group: makeFlowAction('group', 'flow.sequence', { actionIds: ['member'] }),
        member: makeAction('member'),
      },
      connections: { c1: makeConnection('c1', 'button', 'click', ['group']) },
    })

    const orphans = validateDocument(schema).filter((issue) => issue.message.includes('未被'))
    expect(orphans).toEqual([])
  })
})

describe('失败策略一致性', () => {
  it('fallback 策略但没写补救动作时报错', () => {
    const schema = makeSchema({
      actions: { risky: { ...makeAction('risky'), onError: 'fallback' } },
      connections: { c1: makeConnection('c1', 'button', 'click', ['risky']) },
    })

    expect(validateDocument(schema)).toContainEqual(
      expect.objectContaining({ severity: 'error', path: '/actions/risky/fallbackActionId' }),
    )
  })

  it('补救动作指向不存在的动作时报错', () => {
    const schema = makeSchema({
      actions: {
        risky: { ...makeAction('risky'), onError: 'fallback', fallbackActionId: 'ghost' },
      },
      connections: { c1: makeConnection('c1', 'button', 'click', ['risky']) },
    })

    expect(validateDocument(schema)).toContainEqual(
      expect.objectContaining({ severity: 'error', message: '引用的动作 "ghost" 不存在' }),
    )
  })

  it('continue 策略不需要补救动作', () => {
    const schema = makeSchema({
      actions: { risky: { ...makeAction('risky'), onError: 'continue' } },
      connections: { c1: makeConnection('c1', 'button', 'click', ['risky']) },
    })

    expect(validateDocument(schema)).toEqual([])
  })
})

describe('动作引用环检测', () => {
  /** 只看环相关的问题，其余报错与本组用例无关 */
  const cycleIssues = (schema: PageSchema) =>
    validateDocument(schema).filter((issue) => /形成环/.test(issue.message))

  it('flow.condition 指向自己时报环', () => {
    const schema = makeSchema({
      actions: {
        loop: makeFlowAction('loop', 'flow.condition', { trueActionId: 'loop' }),
      },
      connections: { c1: makeConnection('c1', 'button', 'click', ['loop']) },
    })

    expect(cycleIssues(schema)).toHaveLength(1)
    expect(cycleIssues(schema)[0]?.message).toContain('loop → loop')
  })

  it('两个动作互相引用时只报一次环，并给出经过的路径', () => {
    const schema = makeSchema({
      actions: {
        a: makeFlowAction('a', 'flow.condition', { trueActionId: 'b' }),
        b: makeFlowAction('b', 'flow.condition', { trueActionId: 'a' }),
      },
      connections: { c1: makeConnection('c1', 'button', 'click', ['a']) },
    })

    const issues = cycleIssues(schema)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toMatch(/a → b → a|b → a → b/)
  })

  it('序列自引用同样被拦住', () => {
    const schema = makeSchema({
      actions: {
        group: makeFlowAction('group', 'flow.sequence', { actionIds: ['group'] }),
      },
      connections: { c1: makeConnection('c1', 'button', 'click', ['group']) },
    })

    expect(cycleIssues(schema)).toHaveLength(1)
  })

  it('菱形引用（多条路径汇入同一个动作）不是环', () => {
    /**
     * `finished` 集合的作用就在这一条：`d` 会被 `b` 和 `c` 各访问一次，
     * 若把「访问过」当成「在当前栈上」，这里会误报一个不存在的环。
     */
    const schema = makeSchema({
      actions: {
        top: makeFlowAction('top', 'flow.sequence', { actionIds: ['b', 'c'] }),
        b: makeFlowAction('b', 'flow.condition', { trueActionId: 'd' }),
        c: makeFlowAction('c', 'flow.condition', { trueActionId: 'd' }),
        d: makeAction('d'),
      },
      connections: { c1: makeConnection('c1', 'button', 'click', ['top']) },
    })

    expect(validateDocument(schema)).toEqual([])
  })

  it('环检测覆盖未被连接引用的动作', () => {
    const schema = makeSchema({
      actions: {
        a: makeFlowAction('a', 'flow.condition', { trueActionId: 'b' }),
        b: makeFlowAction('b', 'flow.condition', { trueActionId: 'a' }),
      },
      connections: {},
    })

    expect(cycleIssues(schema)).toHaveLength(1)
  })
})

describe('flow.condition 的条件形态', () => {
  const expressionIssues = (config: Record<string, unknown>) => {
    const schema = makeSchema({
      actions: { gate: { id: 'gate', type: 'flow.condition', config } },
      connections: { c1: makeConnection('c1', 'button', 'click', ['gate']) },
    })
    return validateDocument(schema).filter((issue) => /config\/expression/.test(issue.path))
  }

  it('表达式对象不报错', () => {
    expect(expressionIssues({ expression: createExpression('{{ ok }}') })).toEqual([])
  })

  it('裸文本被拒绝：它会在执行时恒为真', () => {
    const issues = expressionIssues({ expression: 'ok > 1' })

    expect(issues).toHaveLength(1)
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.message).toContain('恒为真')
  })

  it('缺条件时报未填写', () => {
    expect(expressionIssues({})).toEqual([
      expect.objectContaining({ severity: 'error', message: '条件未填写' }),
    ])
  })

  it('自定义动作类型不被内置字段规则约束', () => {
    const schema = makeSchema({
      actions: { custom: { id: 'custom', type: 'my.action', config: { expression: 'raw' } } },
      connections: { c1: makeConnection('c1', 'button', 'click', ['custom']) },
    })

    expect(validateDocument(schema)).toEqual([])
  })
})
