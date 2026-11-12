import { describe, expect, it } from 'vitest'
import { highlightJsonLines, plainTextLines } from '../src/components/api/json-highlight'

/**
 * 响应体高亮：着色正确，且外部不可信内容必须先转义。
 *
 * 调试台的响应来自任意服务，一个返回 `<img onerror=…>` 的接口若被原样拼进 v-html，
 * 就能在宿主页面执行脚本——转义这条边界必须钉死。
 */

describe('JSON 语法高亮', () => {
  it('键 / 字符串 / 数字分别着色，逐行输出', () => {
    const lines = highlightJsonLines({ code: 0, message: 'success', data: { id: 123 } })

    expect(lines.length).toBeGreaterThan(1)
    const joined = lines.join('\n')
    expect(joined).toContain('<span class="lc-json-key">"code":</span>')
    expect(joined).toContain('<span class="lc-json-str">"success"</span>')
    expect(joined).toContain('<span class="lc-json-num">123</span>')
    expect(joined).toContain('<span class="lc-json-num">0</span>')
  })

  it('布尔与 null 单独着色，字符串里的裸词不被拆开', () => {
    const joined = highlightJsonLines({ ok: true, missing: null, label: 'true' }).join('\n')

    expect(joined).toContain('<span class="lc-json-bool">true</span>')
    expect(joined).toContain('<span class="lc-json-null">null</span>')
    expect(joined).toContain('<span class="lc-json-str">"true"</span>')
  })

  it('外部内容里的标签被转义，不会拼出可执行标签', () => {
    const joined = highlightJsonLines({ x: '<img src=x onerror=alert(1)>' }).join('\n')

    expect(joined).not.toContain('<img')
    expect(joined).toContain('&lt;img')
    expect(joined).toContain('onerror=alert(1)')
  })

  it('空值给空数组，由视图决定占位', () => {
    expect(highlightJsonLines(undefined)).toEqual([])
  })
})

describe('原始文本响应', () => {
  it('仅转义不着色，逐行输出', () => {
    const lines = plainTextLines('<b>hi</b>\nsecond')

    expect(lines).toEqual(['&lt;b&gt;hi&lt;/b&gt;', 'second'])
    expect(plainTextLines('')).toEqual([])
  })
})
