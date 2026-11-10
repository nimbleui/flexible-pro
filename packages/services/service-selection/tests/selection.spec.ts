import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@lc/kernel'
import type { Context } from '@lc/kernel'
import { installContextServices } from '@lc/contracts'
import type { SelectionService } from '@lc/contracts'
import selectionPlugin from '../src/index'

async function createSelection(): Promise<{ app: Context; selection: SelectionService }> {
  installContextServices()
  const app = createApp({ grants: { 'service-selection': ['selection'] } })
  app.plugin(selectionPlugin)
  await app.runtime.whenIdle()

  return { app, selection: app.require<SelectionService>('selection') }
}

describe('service-selection：选中集状态机', () => {
  it('初始为空集合，primary 为 undefined', async () => {
    const { app, selection } = await createSelection()

    expect(selection.ids).toEqual([])
    expect(selection.primary).toBeUndefined()

    app.dispose()
  })

  it('set 先去重再整体替换，重复 id 不产生多余条目', async () => {
    const { app, selection } = await createSelection()

    selection.set(['a', 'b', 'a', 'c'])

    expect(selection.ids).toEqual(['a', 'b', 'c'])
    expect(selection.primary).toBe('c')

    app.dispose()
  })

  it('集合与顺序都没变时是空操作：不通知、不发事件', async () => {
    const { app, selection } = await createSelection()
    const local = vi.fn()
    const bus = vi.fn()
    selection.onDidChange(local)
    app.on('selection:change', bus)

    selection.set(['a', 'b'])
    expect(local).toHaveBeenCalledTimes(1)
    expect(bus).toHaveBeenCalledTimes(1)

    // 带重复项的等价输入经去重后与当前集合完全相同
    selection.set(['a', 'b', 'a'])
    expect(local).toHaveBeenCalledTimes(1)
    expect(bus).toHaveBeenCalledTimes(1)

    app.dispose()
  })

  it('顺序本身有语义：同样两个 id 换序也算变化，primary 随末位改变', async () => {
    const { app, selection } = await createSelection()

    selection.set(['a', 'b'])
    expect(selection.primary).toBe('b')

    selection.set(['b', 'a'])
    expect(selection.primary).toBe('a')

    app.dispose()
  })

  it('add 把新 id 追加到末尾并改变 primary；重复 id 按首次出现位置去重', async () => {
    const { app, selection } = await createSelection()

    selection.set(['a', 'b'])
    selection.add(['c', 'a'])

    // update 用 [...new Set(...)] 去重，保留首次出现的位置：已选中的 'a' 不会被移到末尾
    expect(selection.ids).toEqual(['a', 'b', 'c'])
    expect(selection.primary).toBe('c')

    selection.add(['d'])
    expect(selection.ids).toEqual(['a', 'b', 'c', 'd'])
    expect(selection.primary).toBe('d')

    app.dispose()
  })

  it('remove 过滤目标 id；空集合与不存在的 id 都是空操作', async () => {
    const { app, selection } = await createSelection()
    const listener = vi.fn()
    selection.onDidChange(listener)

    selection.set(['a', 'b', 'c'])
    selection.remove(['b', 'missing'])
    expect(selection.ids).toEqual(['a', 'c'])
    expect(listener).toHaveBeenCalledTimes(2)

    selection.remove([])
    selection.remove(['not-there'])
    expect(selection.ids).toEqual(['a', 'c'])
    expect(listener).toHaveBeenCalledTimes(2)

    app.dispose()
  })

  it('toggle 未选中则追加为主选中，已选中则取消', async () => {
    const { app, selection } = await createSelection()

    selection.toggle('a')
    expect(selection.ids).toEqual(['a'])
    expect(selection.primary).toBe('a')

    selection.toggle('b')
    expect(selection.ids).toEqual(['a', 'b'])

    selection.toggle('a')
    expect(selection.ids).toEqual(['b'])
    expect(selection.primary).toBe('b')

    app.dispose()
  })

  it('clear 清空集合；对已空集合调用不产生通知', async () => {
    const { app, selection } = await createSelection()
    const listener = vi.fn()
    selection.onDidChange(listener)

    selection.set(['a'])
    selection.clear()
    expect(selection.ids).toEqual([])
    expect(selection.primary).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)

    selection.clear()
    expect(listener).toHaveBeenCalledTimes(2)

    app.dispose()
  })

  it('onDidChange 同一函数重复注册只保留一份，退订后不再收到', async () => {
    const { app, selection } = await createSelection()
    const listener = vi.fn()

    const first = selection.onDidChange(listener)
    const second = selection.onDidChange(listener)
    selection.set(['a'])
    expect(listener).toHaveBeenCalledTimes(1)

    first.dispose()
    selection.set(['b'])
    expect(listener).toHaveBeenCalledTimes(1)
    second.dispose()

    app.dispose()
  })

  it('selection:change 事件携带去重后的 ids 数组', async () => {
    const { app, selection } = await createSelection()
    const seen: string[][] = []
    const subscription = app.on('selection:change', (ids) => seen.push([...ids]))

    selection.set(['x', 'y', 'x'])

    expect(seen).toEqual([['x', 'y']])
    subscription.dispose()

    app.dispose()
  })

  it('ids 返回内部引用：调用方不得 push，服务自身不会就地修改旧数组', async () => {
    const { app, selection } = await createSelection()

    selection.set(['a'])
    const firstRef = selection.ids
    selection.set(['a', 'b'])

    expect(firstRef).toEqual(['a'])
    expect(selection.ids).not.toBe(firstRef)

    app.dispose()
  })
})
