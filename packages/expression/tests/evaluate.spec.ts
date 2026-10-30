import { describe, expect, it } from 'vitest'
import type { ExpressionEngine } from '@lc/schema'
import type { ExpressionError } from '../src/errors'
import { createExpressionEngine } from '../src/index'

function createEngine(): ExpressionEngine {
  return createExpressionEngine()
}

describe('表达式语言：字面量与运算', () => {
  const engine = createEngine()

  it('整值绑定保留原始类型', () => {
    expect(engine.evaluate('{{ count + 1 }}', { count: 2 })).toBe(3)
    expect(engine.evaluate('active', { active: true })).toBe(true)
    expect(engine.evaluate('"文本"', {})).toBe('文本')
    expect(engine.evaluate('true', {})).toBe(true)
    expect(engine.evaluate('null', {})).toBeNull()
    expect(engine.evaluate('undefined', {})).toBeUndefined()
  })

  it('算术与优先级对齐 JS', () => {
    expect(engine.evaluate('1 + 2 * 3', {})).toBe(7)
    expect(engine.evaluate('(1 + 2) * 3', {})).toBe(9)
    expect(engine.evaluate('7 % 3', {})).toBe(1)
    expect(engine.evaluate('7 / 2', {})).toBe(3.5)
    expect(engine.evaluate('-absNumber', { absNumber: 4 })).toBe(-4)
    expect(engine.evaluate('1e3 + 0.5', {})).toBe(1000.5)
  })

  it('任一侧是字符串时 + 走拼接，且 null 转空串', () => {
    expect(engine.evaluate("first + ' / ' + total", { first: 1, total: 3 })).toBe('1 / 3')
    expect(engine.evaluate("missing + ' 项'", {})).toBe(' 项')
    expect(engine.evaluate("'2' + 3", {})).toBe('23')
    expect(engine.evaluate('2 + 3', {})).toBe(5)
  })

  it('比较与相等：字符串按码元、其余按数字', () => {
    expect(engine.evaluate('a > 1 && a < 10', { a: 5 })).toBe(true)
    expect(engine.evaluate("'b' > 'a'", {})).toBe(true)
    expect(engine.evaluate("'2' == 2", {})).toBe(true)
    expect(engine.evaluate("'2' === 2", {})).toBe(false)
    expect(engine.evaluate('null == undefined', {})).toBe(true)
    expect(engine.evaluate('null === undefined', {})).toBe(false)
  })

  it('短路、空值合并与三元', () => {
    expect(engine.evaluate('a && b', { a: 0, b: 2 })).toBe(0)
    expect(engine.evaluate('a || b', { a: '', b: 'fallback' })).toBe('fallback')
    expect(engine.evaluate('a ?? b', { a: null, b: 2 })).toBe(2)
    expect(engine.evaluate('a ?? b', { a: 0, b: 2 })).toBe(0)
    expect(engine.evaluate('missing ?? "默认"', {})).toBe('默认')
    expect(engine.evaluate('ok ? "是" : "否"', { ok: 1 })).toBe('是')
    expect(engine.evaluate('a ? "1" : b ? "2" : "3"', { b: true })).toBe('2')
  })

  it('真值判定遵循 JS：空数组与非空对象为真', () => {
    expect(engine.evaluate('!list', { list: [] })).toBe(false)
    expect(engine.evaluate('!obj', { obj: { a: 1 } })).toBe(false)
    expect(engine.evaluate('!text', { text: '' })).toBe(true)
  })
})

describe('表达式语言：路径与容器', () => {
  const engine = createEngine()

  it('成员访问、下标与越界', () => {
    const scope = { user: { name: 'Ayaka' }, list: ['A', 'B'], data: { 'a-b': 1 } }
    expect(engine.evaluate('user.name', scope)).toBe('Ayaka')
    expect(engine.evaluate('list[1]', scope)).toBe('B')
    expect(engine.evaluate("data['a-b']", scope)).toBe(1)
    expect(engine.evaluate('list.length', scope)).toBe(2)
    expect(engine.evaluate('user.name.length', scope)).toBe(5)
    expect(engine.evaluate('list[9]', scope)).toBeUndefined()
    expect(engine.evaluate('user.missing', scope)).toBeUndefined()
  })

  it('可选链在缺失路径上返回 undefined 而不报错', () => {
    expect(engine.evaluate('a?.b?.c', {})).toBeUndefined()
    expect(engine.evaluate('a?.[0]', {})).toBeUndefined()
    expect(engine.evaluate('list?.length', { list: [1] })).toBe(1)
  })

  it('数组与对象字面量', () => {
    expect(engine.evaluate('[1, 2, x]', { x: 3 })).toEqual([1, 2, 3])
    expect(engine.evaluate('[]', {})).toEqual([])
    expect(engine.evaluate('{ a: 1, "b-c": x, d: { e: 2 } }', { x: 'v' })).toEqual({
      a: 1,
      'b-c': 'v',
      d: { e: 2 },
    })
  })

  it('非普通对象在递归解析中原样透传', () => {
    const date = new Date('2026-01-02T03:04:05.000Z')
    const resolved = engine.resolveValue({ at: date, tags: ['x', '{{ y }}'] }, { y: 1 }) as {
      at: Date
      tags: unknown[]
    }
    expect(resolved.at).toBe(date)
    expect(resolved.tags).toEqual(['x', '1'])
  })

  it('resolveValue 处理表达式对象、嵌套结构与混排字符串', () => {
    const scope = { n: 2, user: { name: 'Yuki' } }
    expect(engine.resolveValue({ type: 'expression', raw: '{{ n * 10 }}' }, scope)).toBe(20)
    expect(engine.resolveValue('用户 {{ user.name }}，共 {{ n }} 项', scope)).toBe(
      '用户 Yuki，共 2 项',
    )
    expect(engine.resolveValue({ deep: { list: [{ value: '{{ n }}' }] } }, scope)).toEqual({
      deep: { list: [{ value: '2' }] },
    })
    expect(engine.resolveValue(42, scope)).toBe(42)
  })
})

describe('表达式语言：方法调用与箭头函数', () => {
  const engine = createEngine()

  it('数组高阶方法', () => {
    const todos = [
      { title: 'a', done: true },
      { title: 'b', done: false },
      { title: 'c', done: true },
    ]
    expect(engine.evaluate('todos.filter(t => t.done).length', { todos })).toBe(2)
    expect(engine.evaluate('todos.map(t => t.title).join("-")', { todos })).toBe('a-b-c')
    expect(engine.evaluate('todos.find(t => !t.done).title', { todos })).toBe('b')
    expect(engine.evaluate('todos.some(t => t.done)', { todos })).toBe(true)
    expect(engine.evaluate('todos.every(t => t.done)', { todos })).toBe(false)
    expect(
      engine.evaluate('todos.reduce((acc, t) => acc + (t.done ? 1 : 0), 0)', { todos }),
    ).toBe(2)
    expect(engine.evaluate('[1, 2, 3].reduce((a, b) => a + b)', {})).toBe(6)
  })

  it('schema 文档里 progress 的官方示例可以整段求值', () => {
    const list = [{ done: true }, { done: false }, { done: true }]
    expect(
      engine.evaluate("list.filter(t => t.done).length + ' / ' + list.length", { list }),
    ).toBe('2 / 3')
  })

  it('排序与反转不改动原数组', () => {
    const source = [3, 1, 2]
    expect(engine.evaluate('source.sort((a, b) => a - b)', { source })).toEqual([1, 2, 3])
    expect(engine.evaluate('source.reverse()', { source })).toEqual([2, 1, 3])
    expect(source).toEqual([3, 1, 2])
  })

  it('数组与字符串的其余方法', () => {
    expect(engine.evaluate('list.includes("A")', { list: ['A'] })).toBe(true)
    expect(engine.evaluate('list.slice(1, 3)', { list: [0, 1, 2, 3] })).toEqual([1, 2])
    expect(engine.evaluate('list.at(-1)', { list: [1, 2] })).toBe(2)
    expect(engine.evaluate('list.concat(other).length', { list: [1], other: [2] })).toBe(2)
    expect(engine.evaluate('text.split(",")', { text: 'a,b' })).toEqual(['a', 'b'])
    expect(engine.evaluate('text.toUpperCase()', { text: 'abc' })).toBe('ABC')
    expect(engine.evaluate("text.startsWith('a')", { text: 'abc' })).toBe(true)
    expect(engine.evaluate('text.replaceAll("a", "X")', { text: 'aaa' })).toBe('XXX')
    expect(engine.evaluate('count.toFixed(2)', { count: 3.14159 })).toBe('3.14')
  })

  it('内置函数', () => {
    expect(engine.evaluate('abs(-2)', {})).toBe(2)
    expect(engine.evaluate('min(3, 1, 2)', {})).toBe(1)
    expect(engine.evaluate('max(list)', { list: [1, 7, 3] })).toBe(7)
    expect(engine.evaluate('round(2.6)', {})).toBe(3)
    expect(engine.evaluate('floor(2.9) + ceil(2.1)', {})).toBe(5)
    expect(engine.evaluate('number("42") + 1', {})).toBe(43)
    expect(engine.evaluate('string(1)', {})).toBe('1')
    expect(engine.evaluate('boolean(0)', {})).toBe(false)
    expect(engine.evaluate('isEmpty(list)', { list: [] })).toBe(true)
    expect(engine.evaluate('isBlank(text)', { text: '  ' })).toBe(true)
    expect(engine.evaluate('stringify({ a: 1 })', {})).toBe('{"a":1}')
  })

  it('宿主注入的函数作为作用域值可被调用', () => {
    const format = (value: unknown) => `#${String(value)}`
    expect(engine.evaluate('format(x)', { x: 7, format })).toBe('#7')
    expect(engine.evaluate('list.map(format).join("")', { list: [1, 2], format })).toBe('#1#2')
  })
})

describe('表达式语言：标识符与插值', () => {
  const engine = createEngine()

  it('允许 Unicode 标识符与中文数据键', () => {
    expect(engine.evaluate('用户.名称', { 用户: { 名称: '张三' } })).toBe('张三')
    expect(engine.evaluate("row['金额']", { row: { 金额: 12 } })).toBe(12)
  })

  it('未绑定变量按 undefined 处理并留痕，而不是让渲染中断', () => {
    const reported: unknown[] = []
    const auditing = createExpressionEngine({
      onDiagnostic: (error) => reported.push(error),
    })

    expect(auditing.evaluate('missing', {})).toBeUndefined()
    expect(auditing.evaluate('foo.bar.baz', {})).toBeUndefined()
    expect(auditing.evaluate('nope ?? 1', {})).toBe(1)

    const kinds = reported.map((error) => (error as ExpressionError).kind)
    expect(kinds).toContain('unbound-identifier')
    expect(kinds).toContain('invalid-operand')

    // 同一串文本重复求值只报一次：设计器里逐字符编辑会把诊断面板刷满
    const before = reported.length
    auditing.evaluate('missing', {})
    auditing.evaluate('nope ?? 1', {})
    expect(reported.length).toBe(before)
  })

  it('interpolate 拼接多段并保留静态文本', () => {
    expect(
      engine.interpolate('共 {{ list.length }} 项，首项 {{ list[0] }}', { list: ['A', 2] }),
    ).toBe('共 2 项，首项 A')
    expect(engine.interpolate('{{ missing }}', {})).toBe('')
    expect(engine.interpolate('{{ a }}-{{ b }}', { a: 1, b: null })).toBe('1-')
    expect(engine.interpolate('纯文本', {})).toBe('纯文本')
  })

  it('compile 结果按文本缓存复用', () => {
    const first = engine.compile('a + b')
    const second = engine.compile('{{ a + b }}')
    expect(first).toBe(second)
    expect(first.source).toBe('a + b')
    expect(first.ast.kind).toBe('binary')
    expect(first.evaluate({ a: 1, b: 2 })).toBe(3)
  })

  it('isExpression 只认表达式对象', () => {
    expect(engine.isExpression({ type: 'expression', raw: '{{ a }}' })).toBe(true)
    expect(engine.isExpression('{{ a }}')).toBe(false)
  })
})
