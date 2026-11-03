import { describe, expect, it } from 'vitest'
import { validateDocument } from '@lc/schema'
import { PAGES } from '../src/pages'

/**
 * 预置页面必须过同一份校验。
 *
 * 这些 schema 是手写的种子数据，一旦违反了动作协议（分支目标指向不存在的动作、
 * 条件写成裸文本、引用成环），预览页上的表现是「点了没反应」而不是报错——
 * 没有这条用例就没人会发现演示文档本身是坏的。
 */
describe('预置页面的事件链', () => {
  for (const page of PAGES) {
    it(`${page.documentId} 的结构校验没有阻断性问题`, () => {
      const blocking = validateDocument(page.createSchema()).filter(
        (issue) => issue.severity === 'error',
      )

      expect(blocking).toEqual([])
    })
  }

  it('事件链演示页面的连接都指向存在的动作', () => {
    const schema = PAGES.find((page) => page.documentId === 'event-doc')?.createSchema()
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
    const schema = PAGES.find((page) => page.documentId === 'event-doc')?.createSchema()
    const sources = Object.values(schema?.connections ?? {}).map((item) => item.sourceNodeId)

    expect(sources).toContain('page')
    expect(sources).toContain('plusButton')
  })
})
