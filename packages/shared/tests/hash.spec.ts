import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '../src/canonical'
import { canonicalHash, canonicalHashAsync, hashText } from '../src/hash'

/** 用 Node 的独立实现做基准，避免「纯 JS 实现只和自己比」的假通过。 */
function expected(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 40)
}

describe('hashText', () => {
  it('空串与 abc 命中标准 SHA-256 前 160 bit', () => {
    expect(hashText('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4')
    expect(hashText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a3')
  })

  it('跨多个 64 字节分组与多字节 UTF-8 仍与标准实现一致', () => {
    const samples = [
      'a'.repeat(64),
      'a'.repeat(65),
      'a'.repeat(1000),
      '中文与 emoji 🚀'.repeat(40),
      '{"nodes":{"n1":{"id":"n1"}},"children":["n1","n2"]}',
    ]

    for (const sample of samples) expect(hashText(sample)).toBe(expected(sample))
  })

  it('不同文本得到不同地址，且地址长度固定为 40', () => {
    expect(hashText('a')).not.toBe(hashText('b'))

    for (const text of ['', 'abc', 'a'.repeat(1000)]) {
      expect(hashText(text)).toMatch(/^[0-9a-f]{40}$/)
    }
  })
})

describe('canonicalHash', () => {
  it('键序不同但内容相同得到同一地址', () => {
    const left = { nodes: { n1: { id: 'n1', x: 1 } }, actions: { a1: { id: 'a1' } } }
    const right = { actions: { a1: { id: 'a1' } }, nodes: { n1: { x: 1, id: 'n1' } } }

    expect(canonicalHash(left)).toBe(canonicalHash(right))
  })

  it('数组顺序属于内容，换序即换地址', () => {
    expect(canonicalHash({ children: ['a', 'b'] })).not.toBe(
      canonicalHash({ children: ['b', 'a'] }),
    )
  })

  it('等价于对规范化文本直接取 hash', () => {
    const value = { b: [1, 2], a: { d: 4, c: 3 } }

    expect(canonicalHash(value)).toBe(hashText(canonicalJson(value)))
  })

  it('无法无损表达的内容同样被拒绝', () => {
    expect(() => canonicalHash({ x: Number.NaN })).toThrow()
  })
})

describe('canonicalHashAsync', () => {
  it('与同步路径结果一致（WebCrypto 可用时覆盖原生加速路径）', async () => {
    const value = { nodes: { n1: { id: 'n1', x: 1 } }, children: ['n1'] }

    expect(await canonicalHashAsync(value)).toBe(canonicalHash(value))
  })

  it('crypto.subtle 不可用（局域网 HTTP 非安全上下文）时回退且结果不变', async () => {
    const value = { nodes: { n1: { id: 'n1' } }, text: '中文 🚀' }

    vi.stubGlobal('crypto', undefined)
    try {
      expect(await canonicalHashAsync(value)).toBe(canonicalHash(value))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
