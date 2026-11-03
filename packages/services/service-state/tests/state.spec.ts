import { describe, expect, it } from 'vitest'
import type { PageVariableSchema } from '@lc/schema'
import { alignState } from '../src'
import type { StateTable } from '../src'

function variable(name: string, defaultValue?: unknown): PageVariableSchema {
  return { name, defaultValue }
}

function makeTable(entries: [string, unknown][] = []): StateTable {
  const table: StateTable = { values: new Map(), fingerprints: new Map() }
  for (const [name, value] of entries) {
    table.values.set(name, value)
    table.fingerprints.set(name, JSON.stringify({ v: value }))
  }
  return table
}

describe('alignState', () => {
  it('新变量按默认值登记', () => {
    const table = makeTable()

    expect(alignState(table, [variable('keyword', ''), variable('count', 3)])).toBe(true)
    expect(table.values.get('keyword')).toBe('')
    expect(table.values.get('count')).toBe(3)
    expect(table.fingerprints.has('keyword')).toBe(true)
  })

  it('没有未声明的变量可对齐时返回 false', () => {
    const table = makeTable()

    expect(alignState(table, [])).toBe(false)
  })

  it('声明未变时保留运行时改出来的当前值', () => {
    /**
     * 这条是本模块存在的核心约束：文档任何无关编辑（改标题、挪节点）都会触发
     * onDidChange → sync，若 sync 无脑按默认值重建，用户点两下按钮攒出来的状态
     * 就会在莫名其妙的时刻被清空。
     */
    const table = makeTable([['keyword', '']])
    table.values.set('keyword', 'typed by user')

    expect(alignState(table, [variable('keyword', '')])).toBe(false)
    expect(table.values.get('keyword')).toBe('typed by user')
  })

  it('默认值被编辑过时重置为新默认值', () => {
    const table = makeTable([['count', 3]])
    table.values.set('count', 99)

    expect(alignState(table, [variable('count', 5)])).toBe(true)
    expect(table.values.get('count')).toBe(5)
  })

  it('声明中消失的变量被删除', () => {
    const table = makeTable([['gone', 1]])

    expect(alignState(table, [])).toBe(true)
    expect(table.values.has('gone')).toBe(false)
    expect(table.fingerprints.has('gone')).toBe(false)
  })

  it('undefined 与 null 的默认值是两个不同的声明', () => {
    /**
     * 指纹要能区分「没写默认值」和「默认值是 null」：两者在表达式里表现不同
     * （`data.x ?? '兜底'` 都一样，但 `typeof data.x` 不同），混淆会让一次
     * 无关的编辑把值表判成「没变」而留下陈旧值。
     */
    const table = makeTable()
    alignState(table, [variable('x', undefined)])
    table.values.set('x', 'runtime')

    expect(alignState(table, [variable('x', undefined)])).toBe(false)
    expect(alignState(table, [variable('x', null)])).toBe(true)
    expect(table.values.get('x')).toBeNull()
  })

  it('对象默认值按内容比较而不是引用', () => {
    const table = makeTable()
    alignState(table, [variable('list', [1, 2])])

    expect(alignState(table, [variable('list', [1, 2])])).toBe(false)
    expect(alignState(table, [variable('list', [1, 2, 3])])).toBe(true)
    expect(table.values.get('list')).toEqual([1, 2, 3])
  })
})
