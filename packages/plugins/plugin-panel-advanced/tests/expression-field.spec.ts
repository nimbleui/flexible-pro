import { describe, expect, it } from 'vitest'
import { fromExpression, toExpression } from '../src/utils/expression-field'

describe('toExpression', () => {
  it('剥掉模板外壳并去掉首尾空白，只存内层文本', () => {
    expect(toExpression('{{  data.count > 0  }}')).toEqual({
      type: 'expression',
      raw: 'data.count > 0',
    })
    expect(toExpression('data.count > 0')).toEqual({
      type: 'expression',
      raw: 'data.count > 0',
    })
  })

  it('空文本与只剩外壳都视为清空，返回 undefined 而不是恒真的空表达式', () => {
    expect(toExpression('   ')).toBeUndefined()
    expect(toExpression('{{ }}')).toBeUndefined()
  })

  it('保留表达式内部的空白与嵌套括号', () => {
    expect(toExpression('{{ (a + b) * 2 }}')?.raw).toBe('(a + b) * 2')
  })
})

describe('fromExpression', () => {
  it('表达式统一带外壳回显', () => {
    expect(fromExpression({ type: 'expression', raw: 'a > b' })).toBe('{{ a > b }}')
    expect(fromExpression({ type: 'expression', raw: '' })).toBe('')
  })

  it('裸字符串原样回显，不顺手包装成语义不同的表达式', () => {
    expect(fromExpression("page.title !== ''")).toBe("page.title !== ''")
  })

  it('非字符串值一律回显为空', () => {
    expect(fromExpression(undefined)).toBe('')
    expect(fromExpression(42)).toBe('')
    expect(fromExpression({ type: 'js', code: 'a > b' })).toBe('')
  })

  it('读写往返稳定，重复编辑不会把外壳越叠越多', () => {
    const first = fromExpression(toExpression('{{ a > b }}'))
    expect(toExpression(first)).toEqual({ type: 'expression', raw: 'a > b' })
    expect(fromExpression(toExpression(first))).toBe(first)
  })
})
