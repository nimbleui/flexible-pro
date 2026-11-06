import { describe, expect, it } from 'vitest'
import { validateDocument } from '@lc/schema'
import { createBuiltinPageSeeds } from '../src/pages/page-seed'

/**
 * 预置页面必须过同一份校验。
 *
 * 这些 schema 是手写的种子数据，一旦违反了动作协议（分支目标指向不存在的动作、
 * 条件写成裸文本、引用成环），预览页上的表现是「点了没反应」而不是报错——
 * 没有这条用例就没人会发现演示文档本身是坏的。
 */
describe('预置页面的事件链', () => {
  const seeds = createBuiltinPageSeeds()

  for (const page of seeds) {
    it(`${page.id} 的结构校验没有阻断性问题`, () => {
      const blocking = validateDocument(page.schema).filter(
        (issue) => issue.severity === 'error',
      )

      expect(blocking).toEqual([])
    })
  }

  it('事件链演示页面的连接都指向存在的动作', () => {
    const schema = seeds.find((page) => page.id === 'event-doc')?.schema
    const connections = schema?.connections ?? {}
    const actions = schema?.actions ?? {}

    for (const connection of Object.values(connections)) {
      for (const actionId of connection.actionIds) {
        expect(
          actions[actionId],
          `连接 ${connection.id} 引用了不存在的动作 ${actionId}`,
        ).toBeDefined()
      }
    }
  })

  it('事件链演示页面把节点事件与页面级事件各绑了一条', () => {
    const schema = seeds.find((page) => page.id === 'event-doc')?.schema
    const sources = Object.values(schema?.connections ?? {}).map((item) => item.sourceNodeId)

    expect(sources).toContain('page')
    expect(sources).toContain('plusButton')
  })

  it('工单管理系统页面把两条页面级事件与按钮点击都接上了动作', () => {
    const connections = Object.values(
      seeds.find((page) => page.id === 'admin-doc')?.schema?.connections ?? {},
    )
    const keys = connections.map((item) => `${item.sourceNodeId}:${item.eventName}`)

    expect(keys).toContain('page:pageLoad')
    expect(keys).toContain('page:pageUnload')
    expect(keys).toContain('btnRefresh:click')

    // 空 actionIds 表示「事件绑了但什么都不做」，在这张演示页里一律视为回归
    for (const connection of connections) {
      expect(
        connection.actionIds.length,
        `连接 ${connection.id} 没有挂任何动作`,
      ).toBeGreaterThan(0)
    }
  })

  it('工单管理系统页面覆盖分支、序列、提前结束与失败兜底', () => {
    const schema = seeds.find((page) => page.id === 'admin-doc')?.schema
    const actions = Object.values(schema?.actions ?? {})
    const types = new Set(actions.map((action) => action.type))

    expect(types.has('flow.condition')).toBe(true)
    expect(types.has('flow.sequence')).toBe(true)
    expect(types.has('flow.end')).toBe(true)

    const fault = actions.find((action) => action.onError === 'fallback')
    expect(fault, '演示页应当保留一条走 fallback 失败策略的动作').toBeDefined()

    // 兜底演示依赖「这个变量确实没声明」；一旦有人补进 variables，写入就会成功，
    // 补救分支再也不会在预览页上出现，而结构校验看不出这种「全都绿但演不出来」
    const declared = new Set((schema?.variables ?? []).map((item) => item.name))
    expect(declared.has(String(fault?.config.key))).toBe(false)
  })
})
