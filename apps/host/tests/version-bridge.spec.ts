import { afterEach, describe, expect, it } from 'vitest'
import type { Commit } from '@lc/contracts'
import {
  MemoryVersionStore,
  type ProjectionMismatch,
  type VersionMode,
} from '@lc/service-version'
import { createBlankPageSchema } from '../src/pages/page-model'
import type { PageRecord } from '../src/pages/page-model'
import type { ProjectReleaseAssets } from '../src/projects/release-model'
import { emitVersionActivity } from '../src/projects/version-activity'
import { createVersionBridge, type VersionBridge } from '../src/projects/version-bridge'

/**
 * 桥接层是「保存/发布 → 版本库」的旁路，重点不是提交算法（已由 service-version 测试覆盖），
 * 而是：默认不动、故障时不影响主链路、连续活动不撞 ref、检出绝不回写草稿。
 */

const STAMP = '2026-11-09T00:00:00.000Z'
const PROJECT_ID = 'project-a'

function makeAssets(label: string): ProjectReleaseAssets {
  const page: PageRecord = {
    id: 'p1',
    title: label,
    schema: createBlankPageSchema(label),
    updatedAt: STAMP,
  }

  return { pages: [page], flows: [], functions: [], components: [], apis: [] }
}

interface Harness {
  bridge: VersionBridge
  label: { value: string }
  commits: (Commit | undefined)[]
  mismatches: ProjectionMismatch[][]
  errors: unknown[]
  changes: string[]
}

const installed: VersionBridge[] = []

afterEach(() => {
  for (const bridge of installed) bridge.dispose()
  installed.length = 0
})

function harness(mode: VersionMode): Harness {
  const store = new MemoryVersionStore()
  const label = { value: '初稿' }
  const commits: (Commit | undefined)[] = []
  const mismatches: ProjectionMismatch[][] = []
  const errors: unknown[] = []
  const changes: string[] = []

  const bridge = createVersionBridge({
    mode,
    readAssets: () => makeAssets(label.value),
    createStore: () => store,
    onCommit: (_projectId, commit) => commits.push(commit),
    onMismatch: (_projectId, list) => mismatches.push(list),
    onError: (_projectId, error) => errors.push(error),
    onChange: (projectId) => changes.push(projectId),
  })
  installed.push(bridge)

  return { bridge, label, commits, mismatches, errors, changes }
}

/** 信号订阅把工作排进 Promise 链，用轮询等待而不是固定延时。 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('等待版本旁路处理超时')
}

/** 让出一个宏任务，把待决的微任务全部冲掉，用于断言「之后不再有多余通知」。 */
function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

const save = { kind: 'save', projectId: PROJECT_ID, docId: 'p1' } as const
const publish = { kind: 'publish', projectId: PROJECT_ID, revision: 7 } as const

describe('灰度档位', () => {
  it('off 时既不捕获提交也不订阅活动，宿主行为完全不变', async () => {
    const h = harness('off')

    await h.bridge.handle(save)
    emitVersionActivity(save)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(h.commits).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
    expect(h.bridge.mode).toBe('off')
  })

  it('shadow 捕获提交并报告双读比对一致', async () => {
    const h = harness('shadow')

    await h.bridge.handle(save)

    expect(h.commits).toHaveLength(1)
    expect(h.commits[0]?.message).toBe('保存页面 p1')
    expect(h.mismatches).toEqual([[]])
    expect(h.errors).toHaveLength(0)
  })

  it('on 只双写、不比对，运行态读取仍走旧资产路径', async () => {
    const h = harness('on')

    await h.bridge.handle(publish)

    expect(h.commits[0]?.message).toBe('发布 v7')
    expect(h.mismatches).toHaveLength(0)
  })
})

describe('提交链路', () => {
  it('重复保存同一内容不产生空提交', async () => {
    const h = harness('shadow')

    await h.bridge.handle(save)
    await h.bridge.handle(save)

    expect(h.commits).toHaveLength(2)
    expect(h.commits[0]).toBeDefined()
    expect(h.commits[1]).toBeUndefined()

    const session = await h.bridge.session(PROJECT_ID)
    expect(await session.service.log()).toHaveLength(1)
  })

  it('内容变化后形成父子链，HEAD 指向新提交', async () => {
    const h = harness('on')

    await h.bridge.handle(save)
    const first = h.commits[0]
    h.label.value = '改稿'
    await h.bridge.handle(publish)
    const second = h.commits[1]

    expect(second?.parents).toEqual([first?.id])
    const session = await h.bridge.session(PROJECT_ID)
    expect(session.service.head.commit).toBe(second?.id)
    expect(await session.service.log()).toHaveLength(2)
  })

  it('连续活动被串行化，不因 ref CAS 撞车而报错', async () => {
    const h = harness('shadow')

    emitVersionActivity(save)
    await waitUntil(() => h.commits.length === 1)
    h.label.value = '改稿'
    emitVersionActivity(publish)
    await waitUntil(() => h.commits.length === 2)

    expect(h.commits.filter((item) => item !== undefined)).toHaveLength(2)
    expect(h.errors).toHaveLength(0)
  })

  it('空库比对报告 missing-in-version，而不是假装一致', async () => {
    const h = harness('shadow')
    const session = await h.bridge.session(PROJECT_ID)
    const result = await session.compare()

    expect(result.length).toBeGreaterThan(0)
    expect(result.every((item) => item.reason === 'missing-in-version')).toBe(true)
  })
})

describe('变化通知合并', () => {
  it('一次提交只通知一次，不按 commit / ref / head 三个事件各通知一遍', async () => {
    const h = harness('on')

    emitVersionActivity(save)
    await waitUntil(() => h.changes.length >= 1)
    await flushMicrotasks()

    expect(h.changes).toEqual([PROJECT_ID])
    expect(h.commits).toHaveLength(1)
  })

  it('两次独立保存各通知一次，合并不跨事件批次', async () => {
    const h = harness('on')

    emitVersionActivity(save)
    await waitUntil(() => h.commits.length === 1)
    h.label.value = '改稿'
    emitVersionActivity(save)
    await waitUntil(() => h.commits.length === 2)
    await flushMicrotasks()

    expect(h.changes).toEqual([PROJECT_ID, PROJECT_ID])
  })
})

describe('故障隔离与检出边界', () => {
  it('读取资产失败只走 onError，不把异常抛回保存路径', async () => {
    const errors: unknown[] = []
    const bridge = createVersionBridge({
      mode: 'shadow',
      readAssets: () => {
        throw new Error('资产 store 不可用')
      },
      createStore: () => new MemoryVersionStore(),
      onError: (_projectId, error) => errors.push(error),
    })
    installed.push(bridge)

    expect(() => emitVersionActivity(save)).not.toThrow()
    await waitUntil(() => errors.length === 1)
    expect(String(errors[0])).toContain('资产 store 不可用')
  })

  it('checkout 只把工作区交给版本视图，绝不回写宿主草稿', async () => {
    const trees: unknown[] = []
    const errors: unknown[] = []
    const store = new MemoryVersionStore()
    const label = { value: '初稿' }
    const bridge = createVersionBridge({
      mode: 'on',
      readAssets: () => makeAssets(label.value),
      createStore: () => store,
      onCheckout: (_projectId, tree) => trees.push(tree),
      onError: (_projectId, error) => errors.push(error),
    })
    installed.push(bridge)

    await bridge.handle(save)
    label.value = '改稿'
    await bridge.handle(publish)

    const session = await bridge.session(PROJECT_ID)
    const history = await session.service.log()
    const oldest = history[history.length - 1].id
    await session.service.createBranch('feature', oldest)
    await session.service.checkout('feature', { force: true })

    expect(trees).toHaveLength(1)
    expect(session.checkedOutTree()).toBeDefined()
    expect(label.value).toBe('改稿')

    // 查看 feature 期间再保存一次：草稿仍属于 main，不能被记到 feature 上。
    // 走信号而不是直接 handle，才能验证失败被 onError 收敛、不抛回保存路径。
    expect(() => emitVersionActivity(save)).not.toThrow()
    await waitUntil(() => errors.length === 1)

    expect(errors[0]).toMatchObject({ code: 'read-only-view' })
    // 两条分支的 ref 都不能动：feature 没被前移，main 也没被这次保存追加提交
    expect((await store.getRef(PROJECT_ID, 'refs/heads/feature'))?.target).toBe(oldest)
    expect((await store.getRef(PROJECT_ID, 'refs/heads/main'))?.target).toBe(history[0].id)
  })
})
