import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Diagnostics } from '../src'

describe('Diagnostics', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('非 Error 上报字符串化成 message，缺 scope 记为 unknown', () => {
    const diagnostics = new Diagnostics()

    diagnostics.report('磁盘已满')

    expect(diagnostics.list()[0]).toMatchObject({ scope: 'unknown', message: '磁盘已满' })
  })

  it('记录有上限，超出后淘汰最早的一条', () => {
    const diagnostics = new Diagnostics()

    for (let index = 0; index < 201; index += 1) {
      diagnostics.report(`boom ${index}`, { scope: 'test' })
    }
    const records = diagnostics.list()

    expect(records).toHaveLength(200)
    expect(records[0]?.message).toBe('boom 1')
  })

  it('onChange 收到新增记录，注销后不再收到', () => {
    const diagnostics = new Diagnostics()
    const received: string[] = []
    const handle = diagnostics.onChange((record) => received.push(record.message))

    diagnostics.report('first', { scope: 'test' })
    handle.dispose()
    diagnostics.report('second', { scope: 'test' })

    expect(received).toEqual(['first'])
  })

  it('订阅者抛错不影响 report，也不影响其他订阅者', () => {
    const diagnostics = new Diagnostics()
    const received: string[] = []

    diagnostics.onChange(() => {
      throw new Error('panel crashed')
    })
    diagnostics.onChange((record) => received.push(record.message))

    expect(() => diagnostics.report('kept', { scope: 'test' })).not.toThrow()
    expect(received).toEqual(['kept'])
    expect(diagnostics.list()).toHaveLength(1)
  })
})
