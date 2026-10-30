import { describe, expect, it } from 'vitest'
import { createContextMenuService } from '../src/menu'

describe('右键菜单注册表', () => {
  it('按 order 升序返回，order 相同保持注册顺序', () => {
    const menu = createContextMenuService()
    menu.register({ id: 'b', order: 2 })
    menu.register({ id: 'c', order: 1 })
    menu.register({ id: 'a', order: 2 })

    expect(menu.list().map((item) => item.id)).toEqual(['c', 'b', 'a'])
  })

  it('缺省 order 视为 0，排在最前', () => {
    const menu = createContextMenuService()
    menu.register({ id: 'late', order: 5 })
    menu.register({ id: 'first' })

    expect(menu.list().map((item) => item.id)).toEqual(['first', 'late'])
  })

  it('id 重复时抛错，避免两个插件互相覆盖', () => {
    const menu = createContextMenuService()
    menu.register({ id: 'dup' })

    expect(() => menu.register({ id: 'dup' })).toThrow(/菜单项 id 重复/)
  })

  it('dispose 只删自己登记的那一条', () => {
    const menu = createContextMenuService()
    const first = menu.register({ id: 'x', order: 1 })
    first.dispose()
    menu.register({ id: 'x', order: 9 })

    // 迟到的第二次 dispose 不能把重新登记的项目删掉
    first.dispose()
    expect(menu.list().map((item) => item.id)).toEqual(['x'])
  })

  it('注册与注销都广播变化', () => {
    const menu = createContextMenuService()
    const seen: number[] = []
    const count = () => seen.push(menu.list().length)

    const off = menu.onDidChange(count)
    const item = menu.register({ id: 'y' })
    item.dispose()
    off.dispose()
    menu.register({ id: 'ignored-after-off' })

    expect(seen).toEqual([1, 0])
  })
})
