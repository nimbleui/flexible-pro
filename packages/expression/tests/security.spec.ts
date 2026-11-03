import { describe, expect, it } from 'vitest'
import type { ExpressionEngine } from '@lc/schema'
import type { ExpressionError, ExpressionErrorKind } from '../src/index'
import { createExpressionEngine } from '../src/index'

/** 返回引擎与它记录到的错误分类，安全用例关心的是「被哪条规则挡下」 */
function auditingEngine(options: Parameters<typeof createExpressionEngine>[0] = {}): {
  engine: ExpressionEngine
  kinds: ExpressionErrorKind[]
} {
  const kinds: ExpressionErrorKind[] = []
  const engine = createExpressionEngine({
    ...options,
    onDiagnostic: (error) => {
      kinds.push((error as ExpressionError).kind)
    },
  })
  return { engine, kinds }
}

describe('表达式安全边界：原型链与危险键', () => {
  it('拒绝读取 __proto__ / constructor / prototype', () => {
    const { engine, kinds } = auditingEngine()
    const scope = { row: { name: 'x' }, key: 'constructor' }

    expect(engine.evaluate('row.__proto__', scope)).toBeUndefined()
    expect(engine.evaluate('row.constructor', scope)).toBeUndefined()
    expect(engine.evaluate('row.prototype', scope)).toBeUndefined()
    expect(engine.evaluate('row[key]', scope)).toBeUndefined()
    expect(engine.evaluate('row?.__proto__.x', scope)).toBeUndefined()

    expect(kinds.filter((kind) => kind === 'forbidden-property')).toHaveLength(5)
  })

  it('被拒绝的键即便来自 JSON 载荷也无法构造出可执行入口', () => {
    const { engine } = auditingEngine()
    const scope = { payload: JSON.parse('{"constructor":{"prototype":1}}') }
    expect(engine.evaluate('payload.constructor', scope)).toBeUndefined()
    expect(engine.evaluate('payload["constructor"].prototype', scope)).toBeUndefined()
  })

  it('函数对象的属性一律不可读，call/apply/bind 无从取得', () => {
    const { engine, kinds } = auditingEngine()
    const scope = { fn: () => 1 }
    expect(engine.evaluate('fn.call', scope)).toBeUndefined()
    expect(engine.evaluate('fn.name', scope)).toBeUndefined()
    expect(kinds.every((kind) => kind === 'forbidden-property')).toBe(true)
  })

  it('方法只能调用，取不到原生函数本体', () => {
    const { engine } = auditingEngine()
    const scope = { list: [1], text: 'abc' }
    expect(engine.evaluate('list.filter', scope)).toBeUndefined()
    expect(engine.evaluate('text.toUpperCase', scope)).toBeUndefined()
    expect(engine.evaluate('list.join', scope)).toBeUndefined()
    // 同一名字作为调用则走白名单表
    expect(engine.evaluate('text.toUpperCase()', scope)).toBe('ABC')
  })

  it('引擎不向作用域暴露任何全局对象', () => {
    const { engine } = auditingEngine()
    for (const name of [
      'window',
      'globalThis',
      'self',
      'document',
      'fetch',
      'eval',
      'Function',
      'this',
    ]) {
      expect(engine.evaluate(name, {})).toBeUndefined()
    }
  })

  it('对象字面量不会把结果对象的原型换掉', () => {
    const { engine } = auditingEngine()
    const result = engine.evaluate('{ __proto__: 1 }', {}) as Record<string, unknown>
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.hasOwn(result, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('resolveValue 重建带 __proto__ 键的载荷时不污染原型', () => {
    const { engine } = auditingEngine()
    const source = JSON.parse('{"__proto__":{"polluted":1},"a":2}')
    const result = engine.resolveValue(source, {}) as Record<string, unknown>

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(result.a).toBe(2)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('Date / Map 的原型方法不可达，这是不查原型链的既定代价', () => {
    const { engine } = auditingEngine()
    const scope = { at: new Date(), dict: new Map([['k', 1]]) }
    expect(engine.evaluate('at.getFullYear', scope)).toBeUndefined()
    expect(engine.evaluate('dict.get("k")', scope)).toBeUndefined()
    expect(engine.evaluate('at.getTime()', scope)).toBeUndefined()
  })
})

describe('表达式安全边界：语法不接受的 JS 构造', () => {
  it('赋值、new、typeof、正则字面量与逗号表达式都是语法错误', () => {
    const { engine, kinds } = auditingEngine()
    for (const text of ['x = 1', 'new Date()', 'typeof x', '/ab/', '1, 2', 'x++']) {
      expect(engine.evaluate(text, { x: 1 })).toBeUndefined()
    }
    expect(kinds.every((kind) => kind === 'syntax')).toBe(true)
  })

  it('箭头函数只能出现在实参位，不会作为值泄漏到输出', () => {
    const { engine } = auditingEngine()
    expect(engine.evaluate('t => t', {})).toBeUndefined()
    expect(engine.evaluate('[t => t]', {})).toBeUndefined()
    expect(engine.evaluate('list.map(t => t)', { list: [1] })).toEqual([1])
  })

  it('下标与可选链下标同样拒绝箭头函数', () => {
    const { engine, kinds } = auditingEngine()
    expect(engine.evaluate('row[key => key]', { row: {}, key: 'a' })).toBeUndefined()
    expect(engine.evaluate('row?.[key => key]', { row: {}, key: 'a' })).toBeUndefined()
    expect(
      engine.evaluate('f(row?.[key => key])', { f: (value: unknown) => value, row: {} }),
    ).toBeUndefined()

    // 三条都必须停在语法层，否则说明箭头函数在非实参位仍被解析成功
    expect(kinds).toEqual(['syntax', 'syntax', 'syntax'])
  })

  it('对象值位置拒绝箭头函数', () => {
    const { engine, kinds } = auditingEngine()
    expect(engine.evaluate('{ slot: k => k }', {})).toBeUndefined()
    expect(kinds).toEqual(['syntax'])
  })

  it('不存在的函数名报错，而不是当普通值返回', () => {
    const { engine, kinds } = auditingEngine()
    expect(engine.evaluate('noSuchFn(1)', {})).toBeUndefined()
    expect(kinds).toEqual(['unknown-function'])
  })
})

describe('表达式安全边界：资源预算', () => {
  it('步数预算挡掉异常庞大的表达式', () => {
    const { engine, kinds } = auditingEngine({ stepBudget: 30 })
    const wide = Array.from({ length: 200 }, (unused, index) => index).join('+')

    expect(engine.evaluate(wide, {})).toBeUndefined()
    expect(kinds).toContain('budget')
  })

  it('调用深度预算挡掉互相递归的自定义函数', () => {
    const { engine, kinds } = auditingEngine({ callDepthLimit: 6 })
    engine.functions.register({ name: 'ping', body: 'pong()' })
    engine.functions.register({ name: 'pong', body: 'ping()' })

    expect(engine.evaluate('ping()', {})).toBeUndefined()
    expect(kinds).toContain('depth')
  })

  it('resolveValue 的递归深度上限兜住自引用结构', () => {
    const { engine, kinds } = auditingEngine({ resolveDepthLimit: 4 })
    const cyclic: Record<string, unknown> = { level: 0 }
    cyclic.self = cyclic

    expect(engine.resolveValue(cyclic, {})).toBeDefined()
    expect(kinds).toContain('depth')
  })
})

/**
 * 时间预算用注入的单调时钟做确定性验证。
 *
 * 真实 `performance.now` 在这两个位置都会触发：每 256 次语法树访问的取样点，
 * 以及每次外部代码（原生方法、内置函数、宿主函数）返回后的检查点。
 * 后者才是关键 —— 一次 `join` 在语法树上只占一个节点，步数预算对它几乎免费。
 */
describe('表达式安全边界：时间预算', () => {
  it('单次昂贵的外部调用被时间预算中止，而步数预算兜不住', () => {
    let clock = 0
    const kinds: ExpressionErrorKind[] = []
    const engine = createExpressionEngine({
      stepBudget: 1_000_000,
      timeBudgetMs: 10,
      now: () => (clock += 100),
      onDiagnostic: (error) => kinds.push((error as ExpressionError).kind),
    })

    const list = Array.from({ length: 5000 }, (unused, index) => index)
    expect(engine.evaluate("list.join('')", { list })).toBeUndefined()
    expect(kinds).toEqual(['timeout'])
  })

  it('纯解释型的长表达式按取样点被中止', () => {
    let clock = 0
    const kinds: ExpressionErrorKind[] = []
    const engine = createExpressionEngine({
      stepBudget: 1_000_000,
      timeBudgetMs: 5,
      // 每次取样只走 1ms，需要累计到 6 次取样才越界：证明取样点本身在起作用，
      // 而不是靠外部调用检查顺手抓到的
      now: () => (clock += 1),
      onDiagnostic: (error) => kinds.push((error as ExpressionError).kind),
    })

    const wide = Array.from({ length: 1500 }, (unused, index) => index).join('+')
    expect(engine.evaluate(wide, {})).toBeUndefined()
    expect(kinds).toEqual(['timeout'])
  })

  it('时间不推进时任何表达式都正常求值，时钟注入点不改变语义', () => {
    const engine = createExpressionEngine({ now: () => 0 })
    const todos = [{ done: true }, { done: false }, { done: true }]

    expect(engine.evaluate('todos.filter(t => t.done).length', { todos })).toBe(2)
    expect(engine.interpolate('进度 {{ todos.length }}', { todos })).toBe('进度 3')
  })

  it('Infinity 关闭时间预算后正常求值，默认值下小表达式不受影响', () => {
    const kinds: ExpressionErrorKind[] = []
    const uncapped = createExpressionEngine({
      timeBudgetMs: Number.POSITIVE_INFINITY,
      onDiagnostic: (error) => kinds.push((error as ExpressionError).kind),
    })
    const list = Array.from({ length: 5000 }, (unused, index) => index)

    expect(uncapped.evaluate('list.filter(n => n % 2 === 0).length', { list })).toBe(2500)
    expect(kinds).toEqual([])

    const { engine } = auditingEngine()
    expect(engine.evaluate("list.join('-')", { list: [1, 2, 3] })).toBe('1-2-3')
  })

  it('两个预算相互独立：大数据先撞步数上限，报 budget 而不是 timeout', () => {
    // 固定时钟排除时间预算干扰，确保这条断言只测步数
    const { engine, kinds } = auditingEngine({ now: () => 0 })
    const list = Array.from({ length: 50_000 }, (unused, index) => index)

    // 默认 stepBudget 10 万次语法树访问，按每个元素约 5 次访问折算，
    // 大约能覆盖 2 万行的简单谓词；再大的数据需要显式调大 stepBudget
    expect(engine.evaluate('list.filter(n => n % 2 === 0).length', { list })).toBeUndefined()
    expect(kinds).toEqual(['budget'])
  })
})
