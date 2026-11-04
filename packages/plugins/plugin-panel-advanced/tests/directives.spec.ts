import { describe, expect, it } from 'vitest'
import type { Directive } from '@lc/schema'
import {
  DIRECTIVE_TYPES,
  appendDirective,
  directiveTypeLabel,
  removeDirective,
  updateDirective,
} from '../src/utils/directives'

const hide: Directive = { type: 'hide', condition: { type: 'expression', raw: 'a > 0' } }
const disabled: Directive = { type: 'disabled', condition: { type: 'expression', raw: 'b' } }

describe('appendDirective', () => {
  it('追加一条空条件的 hide 指令，条件求值为假因此不改变渲染', () => {
    const next = appendDirective([hide])

    expect(next).toHaveLength(2)
    expect(next[1]).toEqual({ type: 'hide', condition: { type: 'expression', raw: '' } })
    // 不改动入参：面板的 computed 缓存依赖原数组引用
    expect(hide.condition.raw).toBe('a > 0')
  })
})

describe('updateDirective', () => {
  it('只替换目标下标，其余条目保持原引用', () => {
    const next = updateDirective([hide, disabled], 1, { type: 'show' })

    expect(next[0]).toBe(hide)
    expect(next[1]).toEqual({ ...disabled, type: 'show' })
  })

  it('下标越界时返回内容相同的新数组而不抛错', () => {
    const list = [hide]
    const next = updateDirective(list, 5, { type: 'show' })

    expect(next).toEqual([hide])
    expect(next).not.toBe(list)
  })
})

describe('removeDirective', () => {
  it('移除目标条目并保持顺序', () => {
    expect(removeDirective([hide, disabled], 0)).toEqual([disabled])
  })

  it('下标越界时不删任何条目', () => {
    expect(removeDirective([hide], 3)).toEqual([hide])
  })
})

describe('DIRECTIVE_TYPES', () => {
  it('覆盖协议声明的全部指令类型', () => {
    const types: readonly Directive['type'][] = [
      'show',
      'hide',
      'disabled',
      'readonly',
      'required',
    ]
    expect(DIRECTIVE_TYPES.map((option) => option.type)).toEqual(types)
  })

  it('渲染层未实现的类型带未生效标注', () => {
    const unimplemented = DIRECTIVE_TYPES.filter((option) => !option.honored).map(
      (option) => option.type,
    )

    expect(unimplemented).toEqual(['readonly', 'required'])
    expect(directiveTypeLabel('readonly')).toContain('未生效')
  })

  it('未知类型回显原文而不是空白，便于发现写错的值', () => {
    expect(directiveTypeLabel('freeze')).toBe('freeze')
  })
})
