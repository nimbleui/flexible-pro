import { describe, expect, it } from 'vitest'
import { listExpressionRefs } from '../src/editor'

describe('listExpressionRefs', () => {
  it('按最长静态链记录，不产出前缀', () => {
    expect(listExpressionRefs('data.users.data')).toEqual([
      { root: 'data', path: 'data.users.data', dynamic: false },
    ])
  })

  it('接受带 {{ }} 外壳的整值绑定', () => {
    expect(listExpressionRefs('{{ count > 0 }}')).toEqual([
      { root: 'count', path: 'count', dynamic: false },
    ])
  })

  it('把字面量下标折成路径段', () => {
    expect(listExpressionRefs('data.list[0].name')).toEqual([
      { root: 'data', path: 'data.list.0.name', dynamic: false },
    ])
    expect(listExpressionRefs("data['a-b']")).toEqual([
      { root: 'data', path: 'data.a-b', dynamic: false },
    ])
  })

  it('动态下标处截断路径，并继续记录下标表达式自身', () => {
    expect(listExpressionRefs('data.list[i].name')).toEqual([
      { root: 'data', path: 'data.list', dynamic: true },
      { root: 'i', path: 'i', dynamic: false },
    ])
  })

  it('方法调用只记录接收者，不记录方法名', () => {
    expect(listExpressionRefs('data.users.data.map(item => item.done)')).toEqual([
      { root: 'data', path: 'data.users.data', dynamic: false },
      { root: 'item', path: 'item.done', dynamic: false },
    ])
  })

  it('函数名按作用域引用记录，方法名不记录', () => {
    expect(listExpressionRefs('isEmpty(data.list)')).toEqual([
      { root: 'isEmpty', path: 'isEmpty', dynamic: false },
      { root: 'data', path: 'data.list', dynamic: false },
    ])
    expect(listExpressionRefs('data.list.length')).toEqual([
      { root: 'data', path: 'data.list.length', dynamic: false },
    ])
  })

  it('遍历三元、数组与短路分支上的引用', () => {
    expect(listExpressionRefs('data.flag ? [a.b, c.d] : event.value')).toEqual([
      { root: 'data', path: 'data.flag', dynamic: false },
      { root: 'a', path: 'a.b', dynamic: false },
      { root: 'c', path: 'c.d', dynamic: false },
      { root: 'event', path: 'event.value', dynamic: false },
    ])
  })

  it('同一路径只记录一次', () => {
    expect(listExpressionRefs('data.count === data.count')).toEqual([
      { root: 'data', path: 'data.count', dynamic: false },
    ])
  })

  it('template 模式只取插值段，裸表达式整段不算引用', () => {
    expect(
      listExpressionRefs('共 {{ data.total }} 项，单位 {{ data.unit }}', 'template'),
    ).toEqual([
      { root: 'data', path: 'data.total', dynamic: false },
      { root: 'data', path: 'data.unit', dynamic: false },
    ])
    expect(listExpressionRefs('data.total', 'template')).toEqual([])
  })

  it('语法错误返回空列表而不是抛出，诊断交给 diagnoseExpression', () => {
    expect(listExpressionRefs('data.')).toEqual([])
    expect(listExpressionRefs('{{ data.a + }}', 'template')).toEqual([])
  })

  it('可选链仍按静态路径记录', () => {
    expect(listExpressionRefs('data.users?.data?.length')).toEqual([
      { root: 'data', path: 'data.users.data.length', dynamic: false },
    ])
  })
})
