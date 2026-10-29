import { describe, expect, it } from 'vitest'
import { materialNameFromDragTypes, toMaterialDragType } from '../src/drag'

describe('物料拖拽 MIME 编码', () => {
  it('大小写经过 types 小写化后仍可还原', () => {
    const type = toMaterialDragType('Text')
    // 浏览器会把 dataTransfer.types 统一转小写
    expect(materialNameFromDragTypes([type.toLowerCase()])).toBe('Text')
  })

  it('支持中文与非 ASCII 物料名', () => {
    const type = toMaterialDragType('统计卡片')
    expect(materialNameFromDragTypes([type.toLowerCase()])).toBe('统计卡片')
  })

  it('非物料拖拽返回 null', () => {
    expect(materialNameFromDragTypes(['text/plain', 'Files'])).toBeNull()
    expect(materialNameFromDragTypes([])).toBeNull()
  })
})
