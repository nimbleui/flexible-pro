import { describe, expect, it } from 'vitest'
import { hasBlockingIssue, validateFlow } from '@lc/schema'
import { createAdminDocumentSchema } from '../src/admin-document'
import { createSeedFlow } from '../src/workflows/flow-template'

/**
 * 内置示例图。
 *
 * 它是 localStorage 为空时的首屏内容，也是用户第一次点「运行调试」看到的图，
 * 所以它必须能通过发布校验（否则首屏就带着红色错误）。
 *
 * 「每个节点都有可执行的去向」这一条目前只在试运行里成立：调试面板自带一套处理器表，
 * 而真实运行只注册了内置动作那几种，示例图用到的 `state.get` / `log.record` /
 * `approval.submit` 在生产处理器表里还不存在，跑到那一步会失败。
 */
describe('内置示例流程', () => {
  const flow = createSeedFlow()

  it('没有阻断问题', () => {
    expect(hasBlockingIssue(validateFlow(flow))).toBe(false)
  })

  it('触发节点只声明来源类型，不写具体绑定', () => {
    const trigger = Object.values(flow.nodes).find((node) => node.type === 'flow.trigger')

    expect(trigger?.config).toEqual({ kind: 'pageEvent' })
  })

  it('示例页面把这张图绑在了一个真实存在的事件上', () => {
    /**
     * 改造前这张图绑的是 `submit-button`，而那个节点在任何种子页面里都不存在——
     * 列表显示「已发布」、看起来配好了，实际永远不会被唤起。绑定搬到页面侧之后，
     * 这条用例同时守住两端：图在、连接在、来源节点真的在页面节点表里。
     */
    const admin = createAdminDocumentSchema()
    const connection = admin.connections?.['on-filter-all']

    expect(connection?.flowId).toBe(flow.id)
    expect(connection?.sourceNodeId).toBe('btnAll')
    expect(admin.nodes[connection?.sourceNodeId ?? '']).toBeDefined()
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
