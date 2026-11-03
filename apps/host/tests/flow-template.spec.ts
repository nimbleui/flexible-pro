import { describe, expect, it } from 'vitest'
import { hasBlockingIssue, validateFlow } from '@lc/schema'
import { createSeedFlow } from '../src/workflows/flow-template'

/**
 * 内置示例图。
 *
 * 它是 localStorage 为空时的首屏内容，也是用户第一次点「运行调试」看到的图，
 * 所以它必须同时满足两件事：能通过发布校验（否则首屏就带着红色错误），
 * 以及每个节点都有可执行的去向（否则试运行半途报「未注册的动作类型」）。
 */
describe('内置示例流程', () => {
  const flow = createSeedFlow()

  it('没有阻断问题', () => {
    expect(hasBlockingIssue(validateFlow(flow))).toBe(false)
  })

  it('触发节点绑定到具体的页面事件', () => {
    const trigger = Object.values(flow.nodes).find((node) => node.type === 'flow.trigger')
    expect(trigger?.config.sourceNodeId).toBe('submit-button')
    expect(trigger?.config.eventName).toBe('click')
  })

  it('条件节点的是 / 否两侧都连了出去', () => {
    const branches = Object.values(flow.edges)
      .filter((edge) => edge.source === 'condition')
      .map((edge) => edge.branch)

    expect(branches.sort()).toEqual(['false', 'true'])
  })

  it('示例图从触发节点可达全部节点', () => {
    const reachable = new Set<string>()
    const adjacency = new Map<string, string[]>()

    for (const edge of Object.values(flow.edges)) {
      const list = adjacency.get(edge.source)
      if (list) list.push(edge.target)
      else adjacency.set(edge.source, [edge.target])
    }

    const queue = ['trigger']
    while (queue.length > 0) {
      const current = queue.shift() as string
      if (reachable.has(current)) continue
      reachable.add(current)
      queue.push(...(adjacency.get(current) ?? []))
    }

    expect([...reachable].sort()).toEqual(Object.keys(flow.nodes).sort())
  })
})
