import { describe, expect, it } from 'vitest'
import type { StyleSchema } from '@lc/schema'
import {
  borderPartEdits,
  boxSideEdits,
  parseBorderShorthand,
  parseSpacingShorthand,
  readBorderParts,
  readBoxSides,
  styleValueEdits,
  toPatches,
} from '../src/utils/style-fields'

describe('parseSpacingShorthand', () => {
  it('按 CSS 折叠规则展开 1 到 4 个值', () => {
    expect(parseSpacingShorthand('12px')).toEqual({
      top: '12px',
      right: '12px',
      bottom: '12px',
      left: '12px',
    })
    expect(parseSpacingShorthand('12px 8px')).toEqual({
      top: '12px',
      right: '8px',
      bottom: '12px',
      left: '8px',
    })
    expect(parseSpacingShorthand('1px 2px 3px')).toEqual({
      top: '1px',
      right: '2px',
      bottom: '3px',
      left: '2px',
    })
    expect(parseSpacingShorthand('1px 2px 3px 4px')).toEqual({
      top: '1px',
      right: '2px',
      bottom: '3px',
      left: '4px',
    })
  })

  it('括号内的空格不作为分隔符', () => {
    expect(parseSpacingShorthand('calc(10px + 2px) 4px')).toEqual({
      top: 'calc(10px + 2px)',
      right: '4px',
      bottom: 'calc(10px + 2px)',
      left: '4px',
    })
  })

  it('空串是四边都不设值，超过四段无法解释', () => {
    expect(parseSpacingShorthand('   ')).toEqual({ top: '', right: '', bottom: '', left: '' })
    expect(parseSpacingShorthand('1px 2px 3px 4px 5px')).toBeNull()
  })
})

describe('readBoxSides', () => {
  it('逐边合并：长手覆盖对应边，其余边仍取简写', () => {
    const style: StyleSchema = { padding: '4px', 'padding-top': '12px' }
    expect(readBoxSides(style, 'padding')).toEqual({
      top: '12px',
      right: '4px',
      bottom: '4px',
      left: '4px',
    })
  })

  it('对象形态按四方向读取', () => {
    expect(readBoxSides({ padding: { top: '1px', left: '2px' } }, 'padding')).toEqual({
      top: '1px',
      right: '',
      bottom: '',
      left: '2px',
    })
  })

  it('没有样式对象时返回空四边而不是抛错', () => {
    expect(readBoxSides(undefined, 'margin')).toEqual({
      top: '',
      right: '',
      bottom: '',
      left: '',
    })
  })
})

describe('boxSideEdits', () => {
  it('改一条边时把其余边一起落成长手键，并拆掉简写', () => {
    expect(boxSideEdits({ padding: '4px' }, 'padding', 'top', '12px')).toEqual([
      { key: 'padding-top', value: '12px' },
      { key: 'padding-right', value: '4px' },
      { key: 'padding-bottom', value: '4px' },
      { key: 'padding-left', value: '4px' },
      { key: 'padding' },
    ])
  })

  it('对象形态同样展开，改上边不会弄丢左边的值', () => {
    const style: StyleSchema = { padding: { top: '1px', left: '2px' } }

    expect(boxSideEdits(style, 'padding', 'top', '12px')).toEqual([
      { key: 'padding-top', value: '12px' },
      { key: 'padding-left', value: '2px' },
      { key: 'padding' },
    ])
  })

  it('清空某边只删该边的长手键', () => {
    expect(boxSideEdits({ 'padding-top': '12px' }, 'padding', 'top', '')).toEqual([
      { key: 'padding-top' },
    ])
  })

  it('清空对象形态的最后一条边时把对象一起拆掉', () => {
    expect(boxSideEdits({ padding: { top: '1px' } }, 'padding', 'top', '')).toEqual([
      { key: 'padding' },
    ])
  })

  it('值没变或本来就没有值时不产生变更，避免留下空历史', () => {
    expect(boxSideEdits({ 'padding-top': '12px' }, 'padding', 'top', ' 12px ')).toEqual([])
    expect(boxSideEdits({}, 'margin', 'left', '')).toEqual([])
    expect(boxSideEdits(undefined, 'margin', 'left', '')).toEqual([])
  })

  it('首次写入时不附带删除不存在的简写键', () => {
    expect(boxSideEdits({}, 'padding', 'right', '8px')).toEqual([
      { key: 'padding-right', value: '8px' },
    ])
  })
})

describe('parseBorderShorthand', () => {
  it('按部件归类而不是按书写顺序取值', () => {
    expect(parseBorderShorthand('solid 1px #ccc')).toEqual({
      width: '1px',
      style: 'solid',
      color: '#ccc',
    })
    expect(parseBorderShorthand('2px dashed')).toEqual({
      width: '2px',
      style: 'dashed',
      color: '',
    })
  })

  it('函数调用形式的颜色整体保留在颜色位', () => {
    expect(parseBorderShorthand('1px solid rgb(0, 0, 0)')).toEqual({
      width: '1px',
      style: 'solid',
      color: 'rgb(0, 0, 0)',
    })
  })

  it('无法识别的段落保留在颜色位而不是丢弃', () => {
    expect(parseBorderShorthand('1px solid var(--brand)')).toEqual({
      width: '1px',
      style: 'solid',
      color: 'var(--brand)',
    })
  })
})

describe('readBorderParts', () => {
  it('逐部件合并：长手覆盖对应部件，其余仍取简写', () => {
    expect(readBorderParts({ border: '1px solid red', 'border-style': 'dashed' })).toEqual({
      width: '1px',
      style: 'dashed',
      color: 'red',
    })
    expect(readBorderParts({ border: '1px solid red' })).toEqual({
      width: '1px',
      style: 'solid',
      color: 'red',
    })
    expect(readBorderParts(undefined)).toEqual({ width: '', style: '', color: '' })
  })
})

describe('borderPartEdits', () => {
  it('改一个部件时把三要素一起落地，并拆掉 border 简写', () => {
    expect(borderPartEdits({ border: '1px solid red' }, 'style', 'dashed')).toEqual([
      { key: 'border-width', value: '1px' },
      { key: 'border-style', value: 'dashed' },
      { key: 'border-color', value: 'red' },
      { key: 'border' },
    ])
  })

  it('已有长手部件时只改目标，不动其它键', () => {
    expect(borderPartEdits({ 'border-width': '1px' }, 'style', 'solid')).toEqual([
      { key: 'border-style', value: 'solid' },
    ])
  })

  it('清空唯一有值的部件时删掉该键', () => {
    expect(borderPartEdits({ 'border-style': 'solid' }, 'style', '')).toEqual([
      { key: 'border-style' },
    ])
  })
})

describe('styleValueEdits', () => {
  it('空串删键、同值不变更', () => {
    expect(styleValueEdits({ borderRadius: '8px' }, 'borderRadius', '')).toEqual([
      { key: 'borderRadius' },
    ])
    expect(styleValueEdits({ borderRadius: '8px' }, 'borderRadius', '8px')).toEqual([])
    expect(styleValueEdits({}, 'fontSize', '14px')).toEqual([
      { key: 'fontSize', value: '14px' },
    ])
  })

  it('数字存量按 px 比较，避免 12 与 "12px" 被判成两个值', () => {
    expect(styleValueEdits({ minWidth: 12 }, 'minWidth', '12px')).toEqual([])
  })
})

describe('toPatches', () => {
  it('有值走 replace，无值走 remove，路径由调用方拼装', () => {
    const patches = toPatches(
      [{ key: 'padding-top', value: '12px' }, { key: 'padding' }],
      (key) => `/nodes/n1/style/${key}`,
    )

    expect(patches).toEqual([
      { op: 'replace', path: '/nodes/n1/style/padding-top', value: '12px' },
      { op: 'remove', path: '/nodes/n1/style/padding' },
    ])
  })
})
