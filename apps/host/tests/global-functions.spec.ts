import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROJECT_ID } from '../src/projects/project-model'
import type { GlobalFunction } from '../src/functions/global-functions'
import { flushIdb, stubFreshIndexedDB } from './support/idb'

/**
 * 全局函数 store 改成「启动前 hydrate + 写穿 IndexedDB」，沿用 release-store.spec 的
 * 「先 stub、再动态 import」手法：每个用例装一份干净的内存 IDB 与模块实例。
 * 本文件聚焦作用域分类字段：缺省口径、更新语义与读档收窄。
 */
const STAMP = '2026-11-08T00:00:00.000Z'

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: 'progress',
    body: 'done / total',
    projectId: DEFAULT_PROJECT_ID,
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetModules()
  stubFreshIndexedDB()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('全局函数作用域分类', { timeout: 20_000 }, () => {
  it('缺省分类不落字段，展示口径按全局解释', async () => {
    const store = await import('../src/functions/global-functions')
    await store.hydrate()

    const entry = store.saveGlobalFunction(input())

    expect(entry.scope).toBeUndefined()
    expect(store.resolveFunctionScope(entry.scope)).toBe('global')

    await flushIdb()
    const idb = await import('../src/storage/idb')
    const rows = await idb.getAll<GlobalFunction>(idb.STORE.globalFunctions)
    expect(rows[0]?.scope).toBeUndefined()
  })

  it('显式分类落库并在重新读档后保留', async () => {
    const store = await import('../src/functions/global-functions')
    await store.hydrate()
    store.saveGlobalFunction(input({ scope: 'page' }))

    await flushIdb()
    vi.resetModules()
    const reloaded = await import('../src/functions/global-functions')
    await reloaded.hydrate()

    expect(reloaded.globalFunctions.value[0]?.scope).toBe('page')
  })

  it('更新时显式分类覆盖原值，缺省保留原值', async () => {
    const store = await import('../src/functions/global-functions')
    await store.hydrate()
    const entry = store.saveGlobalFunction(input({ scope: 'private' }))

    const kept = store.saveGlobalFunction(input({ id: entry.id, body: 'done + 1' }))
    expect(kept.scope).toBe('private')

    const changed = store.saveGlobalFunction(input({ id: entry.id, scope: 'global' }))
    expect(changed.scope).toBe('global')
  })

  it('读档丢弃非法分类，接受没有分类的存量记录', async () => {
    const idb = await import('../src/storage/idb')
    await idb.replaceAll(idb.STORE.globalFunctions, [
      { id: 'fn-bad', name: 'bad', body: '1', updatedAt: STAMP, scope: 'workspace' },
      { id: 'fn-legacy', name: 'legacy', body: '2', updatedAt: STAMP },
      { id: 'fn-ok', name: 'ok', body: '3', updatedAt: STAMP, scope: 'private' },
    ])

    const store = await import('../src/functions/global-functions')
    await store.hydrate()

    expect(store.globalFunctions.value.map((fn) => fn.id)).toEqual(['fn-legacy', 'fn-ok'])
  })

  it('保存校验不因分类字段放松：空名、重名、未知 id 仍然抛错', async () => {
    const store = await import('../src/functions/global-functions')
    await store.hydrate()
    store.saveGlobalFunction(input())

    expect(() => store.saveGlobalFunction(input({ name: ' ' }))).toThrow()
    expect(() => store.saveGlobalFunction(input({ scope: 'page' }))).toThrow(/重复/)
    expect(() => store.saveGlobalFunction(input({ id: 'fn-missing', name: 'other' }))).toThrow(
      /不存在/,
    )
  })
})
