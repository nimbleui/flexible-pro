import { describe, expect, it } from 'vitest'
import type { KeyInput } from '../src/keys'
import { matchesKeybinding } from '../src/keys'

function keydown(key: string, init: Partial<KeyInput> = {}): KeyInput {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }
}

describe('快捷键匹配', () => {
  it('Mod 在 Windows 上解析为 Ctrl', () => {
    expect(matchesKeybinding('Mod+Z', keydown('z', { ctrlKey: true }), 'other')).toBe(true)
    expect(matchesKeybinding('Mod+Z', keydown('z', { metaKey: true }), 'other')).toBe(false)
  })

  it('Mod 在 macOS 上解析为 ⌘', () => {
    expect(matchesKeybinding('Mod+Z', keydown('z', { metaKey: true }), 'mac')).toBe(true)
    expect(matchesKeybinding('Mod+Z', keydown('z', { ctrlKey: true }), 'mac')).toBe(false)
  })

  it('修饰键必须精确一致，避免 ArrowUp 与 Shift+ArrowUp 冲突', () => {
    expect(matchesKeybinding('ArrowUp', keydown('ArrowUp'), 'other')).toBe(true)
    expect(matchesKeybinding('ArrowUp', keydown('ArrowUp', { shiftKey: true }), 'other')).toBe(
      false,
    )
    expect(
      matchesKeybinding('Shift+ArrowUp', keydown('ArrowUp', { shiftKey: true }), 'other'),
    ).toBe(true)
  })

  it('字母键大小写与命名键归一化', () => {
    expect(matchesKeybinding('Mod+D', keydown('D', { ctrlKey: true }), 'other')).toBe(true)
    expect(matchesKeybinding('Delete', keydown('Delete'), 'other')).toBe(true)
    expect(matchesKeybinding('Space', keydown(' '), 'other')).toBe(true)
  })
})
