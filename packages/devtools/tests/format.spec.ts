import { describe, expect, it } from 'vitest'
import {
  describeError,
  formatClock,
  formatDuration,
  formatZoom,
  summarizeValue,
  toDisplayJson,
} from '../src/core/format'

describe('describeError', () => {
  it('Error 带类型名，包装错误补上 cause', () => {
    expect(describeError(new Error('boom'))).toBe('Error: boom')
    expect(describeError(new TypeError('外层', { cause: new Error('内层') }))).toBe(
      'TypeError: 外层 ← Error: 内层',
    )
  })

  it('非 Error 值转文本', () => {
    expect(describeError('纯文本')).toBe('纯文本')
    expect(describeError(undefined)).toBe('undefined')
    expect(describeError(null)).toBe('null')
    expect(describeError({ code: 500 })).toBe('[object Object]')
  })
})

describe('formatDuration', () => {
  it('亚毫秒保留十分位，秒与分钟分别换算', () => {
    expect(formatDuration(0)).toBe('0.0 ms')
    expect(formatDuration(0.04)).toBe('0.0 ms')
    expect(formatDuration(12.34)).toBe('12.3 ms')
    expect(formatDuration(999)).toBe('999.0 ms')
    expect(formatDuration(1_500)).toBe('1.50 s')
    expect(formatDuration(65_000)).toBe('1 min 5 s')
    expect(formatDuration(120_000)).toBe('2 min')
  })

  it('异常输入显示占位符而不是 NaN', () => {
    expect(formatDuration(-1)).toBe('-')
    expect(formatDuration(Number.NaN)).toBe('-')
  })
})

describe('formatClock / formatZoom', () => {
  it('时间戳转本地时分秒毫秒', () => {
    const clock = formatClock(new Date(2026, 0, 5, 9, 8, 7, 6).getTime())
    expect(clock).toBe('09:08:07.006')
  })

  it('缩放转百分比', () => {
    expect(formatZoom(1)).toBe('100%')
    expect(formatZoom(0.125)).toBe('13%')
  })
})

describe('summarizeValue', () => {
  it('给出类型与规模，不展开内部结构', () => {
    expect(summarizeValue(null)).toBe('null')
    expect(summarizeValue(undefined)).toBe('undefined')
    expect(summarizeValue(1)).toBe('number')
    expect(summarizeValue([1, 2, 3])).toBe('Array(3)')
    expect(summarizeValue(new Map([['a', 1]]))).toBe('Map(1)')
    expect(summarizeValue(new Set([1]))).toBe('Set(1)')
    expect(summarizeValue({ a: 1, b: 2 })).toBe('Object(2)')
    expect(summarizeValue(new TypeError('x'))).toBe('Error(TypeError)')
    expect(summarizeValue(() => {})).toBe('fn(anonymous)')
    expect(summarizeValue(function named() {})).toBe('fn(named)')
  })

  it('类实例带构造器名', () => {
    class Service {}
    expect(summarizeValue(new Service())).toBe('Service(0)')
  })
})

describe('toDisplayJson', () => {
  it('循环引用与深度截断', () => {
    const circle: Record<string, unknown> = { name: 'root' }
    circle['self'] = circle
    expect(toDisplayJson(circle)).toContain('[Circular]')

    let deep: unknown = 0
    for (let level = 0; level < 20; level += 1) deep = { next: deep }
    expect(toDisplayJson(deep)).toContain('[Depth]')
  })

  it('函数、Symbol、bigint 与 Error 转成可读占位', () => {
    const text = toDisplayJson({
      fn: function handler() {},
      sym: Symbol('tag'),
      big: 10n,
      err: new Error('boom'),
    })

    expect(text).toContain('"[Function handler]"')
    expect(text).toContain('"Symbol(tag)"')
    expect(text).toContain('"10"')
    expect(text).toContain('"Error: boom"')
  })

  it('Map 与 Set 展开规模，非字符串键换成摘要', () => {
    const text = toDisplayJson({ map: new Map([['a', 1]]), set: new Set([1, 2]) })
    expect(text).toContain('"#Map": 1')
    expect(text).toContain('"#Set"')

    const numeric = toDisplayJson(new Map([[1, 'x']]))
    expect(numeric).toContain('[number]')
  })

  it('顶层 undefined 与 null 有稳定输出', () => {
    expect(toDisplayJson(undefined)).toBe('undefined')
    expect(toDisplayJson(null)).toBe('null')
  })
})
