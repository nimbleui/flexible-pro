import { describe, expect, it } from 'vitest'
import type { ExpressionEngine, FunctionRegistration } from '@lc/schema'
import type { ExpressionError, ExpressionErrorKind } from '../src/index'
import { createExpressionEngine } from '../src/index'

function withDiagnostics(): { engine: ExpressionEngine; kinds: ExpressionErrorKind[] } {
  const kinds: ExpressionErrorKind[] = []
  const engine = createExpressionEngine({
    onDiagnostic: (error) => kinds.push((error as ExpressionError).kind),
  })
  return { engine, kinds }
}

describe('声明式函数：注册与调用', () => {
  it('跑通 schema 文档里 progress 的官方示例', () => {
    const { engine } = withDiagnostics()
    engine.functions.register({
      name: 'progress',
      params: ['list'],
      body: "list.filter(t => t.done).length + ' / ' + list.length",
    })

    const list = [{ done: true }, { done: false }, { done: true }]
    expect(engine.evaluate('progress(todos)', { todos: list })).toBe('2 / 3')
    expect(engine.interpolate('进度：{{ progress(todos) }}', { todos: list })).toBe(
      '进度：2 / 3',
    )
  })

  it('body 的三种写法都接受', () => {
    const { engine } = withDiagnostics()
    engine.functions.register({ name: 'bare', params: ['a', 'b'], body: 'a + b' })
    engine.functions.register({ name: 'braced', params: ['a', 'b'], body: '{{ a + b }}' })
    engine.functions.register({
      name: 'object',
      params: ['a', 'b'],
      body: { type: 'expression', raw: '{{ a * b }}' },
    })

    expect(engine.evaluate('bare(1, 2)', {})).toBe(3)
    expect(engine.evaluate('braced(1, 2)', {})).toBe(3)
    expect(engine.evaluate('object(3, 4)', {})).toBe(12)
  })

  it('形参按位置绑定，缺省实参转成空串参与拼接', () => {
    const { engine } = withDiagnostics()
    engine.functions.register({
      name: 'join3',
      params: ['a', 'b', 'c'],
      body: "a + '/' + b + '/' + c",
    })

    expect(engine.evaluate('join3(1, 2, 3)', {})).toBe('1/2/3')
    expect(engine.evaluate('join3(1, 2)', {})).toBe('1/2/')
  })

  it('函数体只看得到形参，看不到调用处的局部变量', () => {
    const { engine, kinds } = withDiagnostics()
    engine.functions.register({ name: 'peek', body: 'secret' })

    // 扁平作用域是刻意的：否则同一个函数在不同节点上的结果会不同，
    // 「纯函数」的承诺与设计器的静态校验都失效
    expect(engine.evaluate('peek()', { secret: 'caller-local' })).toBeUndefined()
    expect(kinds).toContain('unbound-identifier')
  })

  it('函数之间可以互相调用', () => {
    const { engine } = withDiagnostics()
    engine.functions.register({ name: 'twice', params: ['n'], body: 'n + n' })
    engine.functions.register({ name: 'quad', params: ['n'], body: 'twice(twice(n))' })

    expect(engine.evaluate('quad(3)', {})).toBe(12)
  })

  it('自定义函数可以调用内置函数', () => {
    const { engine } = withDiagnostics()
    engine.functions.register({ name: 'gap', params: ['a', 'b'], body: 'abs(a - b)' })

    expect(engine.evaluate('gap(3, 10)', {})).toBe(7)
  })
})

describe('声明式函数：层级与注销', () => {
  it('页面级覆盖物料级，注销页面级后恢复物料级', () => {
    const { engine } = withDiagnostics()
    const material: FunctionRegistration = engine.functions.register(
      { name: 'fmt', params: ['v'], body: "'物料' + v" },
      'material',
    )
    const page = engine.functions.register(
      { name: 'fmt', params: ['v'], body: "'页面' + v" },
      'page',
    )

    expect(engine.evaluate('fmt(1)', {})).toBe('页面1')
    page.dispose()
    expect(engine.evaluate('fmt(1)', {})).toBe('物料1')

    material.dispose()
    expect(engine.evaluate('fmt(1)', {})).toBeUndefined()
  })

  it('低层重复注册不会夺走已有的高层覆盖', () => {
    const { engine } = withDiagnostics()
    const page = engine.functions.register({ name: 'label', body: "'page'" }, 'page')
    engine.functions.register({ name: 'label', body: "'material'" }, 'material')

    expect(engine.evaluate('label()', {})).toBe('page')
    page.dispose()
    expect(engine.evaluate('label()', {})).toBeUndefined()
  })

  it('registerAll 一次注销整批函数', () => {
    const { engine } = withDiagnostics()
    const batch = engine.functions.registerAll(
      [
        { name: 'one', body: '1' },
        { name: 'two', body: '2' },
      ],
      'page',
    )

    expect(engine.evaluate('one() + two()', {})).toBe(3)
    batch.dispose()
    expect(engine.evaluate('one()', {})).toBeUndefined()
  })

  it('dispose 幂等，且不会撤销后来者的同名注册', () => {
    const { engine } = withDiagnostics()
    const first = engine.functions.register({ name: 'dup', body: "'first'" })
    first.dispose()
    first.dispose()

    engine.functions.register({ name: 'dup', body: "'second'" })
    expect(engine.evaluate('dup()', {})).toBe('second')
  })
})

describe('声明式函数：注册失败的处理', () => {
  it('内置函数不可被覆盖，与之重名的注册被拒绝并上报', () => {
    const { engine, kinds } = withDiagnostics()
    engine.functions.register({ name: 'abs', params: ['n'], body: 'n * 100' })

    expect(engine.evaluate('abs(-2)', {})).toBe(2)
    expect(kinds).toEqual(['invalid-registration'])
    expect(engine.functions.has('abs')).toBe(true)
  })

  it('函数体语法非法时跳过该函数，其余注册与渲染不受影响', () => {
    const { engine, kinds } = withDiagnostics()
    engine.functions.register({ name: 'broken', body: '1 +' })
    engine.functions.register({ name: 'ok', body: '1' })

    expect(engine.evaluate('broken()', {})).toBeUndefined()
    expect(engine.evaluate('ok()', {})).toBe(1)
    expect(kinds.filter((kind) => kind === 'syntax').length).toBeGreaterThan(0)
  })

  it('非法名字（空、关键字、带空格）被拒绝', () => {
    const { engine } = withDiagnostics()
    engine.functions.register({ name: '', body: '1' })
    engine.functions.register({ name: 'null', body: '1' })
    engine.functions.register({ name: 'a b', body: '1' })

    expect(engine.functions.has('null')).toBe(false)
    expect(engine.functions.has('a b')).toBe(false)
    expect(engine.evaluate('null', {})).toBeNull()
  })

  it('has 覆盖内置与已注册函数', () => {
    const { engine } = withDiagnostics()
    expect(engine.functions.has('round')).toBe(true)
    expect(engine.functions.has('mine')).toBe(false)
    engine.functions.register({ name: 'mine', body: '1' })
    expect(engine.functions.has('mine')).toBe(true)
  })
})
