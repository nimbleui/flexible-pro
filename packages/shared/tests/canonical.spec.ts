import { describe, expect, it } from 'vitest'
import { CanonicalValueError, canonicalJson } from '../src/canonical'

describe('canonicalJson', () => {
  it('对象键序不影响输出，且输出为紧凑文本', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('嵌套对象逐层排序', () => {
    const value = {
      outer: { z: 1, a: { d: 2, c: 3 } },
      first: 0,
    }

    expect(canonicalJson(value)).toBe('{"first":0,"outer":{"a":{"c":3,"d":2},"z":1}}')
  })

  it('数组保序：顺序不同必须得到不同文本', () => {
    expect(canonicalJson({ children: ['a', 'b'] })).not.toBe(
      canonicalJson({ children: ['b', 'a'] }),
    )
  })

  it('对象的 undefined 键剔除，数组内 undefined 抛错', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}')
    expect(() => canonicalJson({ list: [1, undefined, 3] })).toThrow(CanonicalValueError)
  })

  it('顶层 undefined 抛错', () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalValueError)
  })

  it('-0 归一为 0，NaN 与 Infinity 抛错', () => {
    expect(canonicalJson(-0)).toBe('0')
    expect(canonicalJson({ x: -0 })).toBe(canonicalJson({ x: 0 }))
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(CanonicalValueError)
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow(/Infinity/)
  })

  it('字符串转义交给 JSON.stringify，不自行拼接', () => {
    expect(canonicalJson({ text: 'a\n"b' })).toBe('{"text":"a\\n\\"b"}')
  })

  it('键按 Unicode 码点而非 UTF-16 码元排序', () => {
    // U+FFFF 的码元 0xFFFF 大于 emoji 首代理项 0xD83D，按码元排会把 emoji 放前面
    const value = { '\uFFFF': 1, '\u{1F600}': 2 }
    const parsed = JSON.parse(canonicalJson(value)) as Record<string, number>

    expect(Object.keys(parsed)).toEqual(['\uFFFF', '\u{1F600}'])
  })

  it('同一对象在不同位置重复出现不算循环引用', () => {
    const shared = { x: 1 }

    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}')
  })

  it('祖先链上的循环引用抛错', () => {
    const value: Record<string, unknown> = { a: 1 }
    value.self = value

    expect(() => canonicalJson(value)).toThrow(/循环引用/)
  })

  it('类实例与 JSON 无法表达的类型一律抛错', () => {
    expect(() => canonicalJson(new Date())).toThrow(CanonicalValueError)
    expect(() => canonicalJson({ x: 1n })).toThrow(CanonicalValueError)
    expect(() => canonicalJson({ x: () => 1 })).toThrow(CanonicalValueError)
    expect(() => canonicalJson({ x: Symbol('a') })).toThrow(CanonicalValueError)
  })

  it('null 原型对象按纯对象处理', () => {
    const value = Object.create(null) as Record<string, unknown>
    value.b = 2
    value.a = 1

    expect(canonicalJson(value)).toBe('{"a":1,"b":2}')
  })
})
