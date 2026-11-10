import type { VersionDocument, VersionServiceOptions, WorkingTree } from '@lc/contracts'
import { describe, expect, it } from 'vitest'
import { commitIdOf } from '../src/object'
import { createVersionService } from '../src/service'
import { MemoryVersionStore } from '../src/store/memory'

function doc(sections: Record<string, unknown>): VersionDocument {
  return { kind: 'page', docSchemaVersion: '1.0.0', sections }
}

function workspace(initial: WorkingTree) {
  let tree = structuredClone(initial)

  return {
    read: () => structuredClone(tree),
    write: (next: WorkingTree) => {
      tree = structuredClone(next)
    },
    current: () => structuredClone(tree),
  }
}

/**
 * 宿主当前的工作区形态：`writeWorkingTree` 只把树投影给只读版本视图，草稿不受影响。
 * `setDraft` 模拟用户在设计器里继续编辑。
 */
function projectedWorkspace(initial: WorkingTree) {
  let draft = structuredClone(initial)
  let projected: WorkingTree | undefined

  return {
    read: () => structuredClone(draft),
    write: (next: WorkingTree) => {
      projected = structuredClone(next)
    },
    setDraft: (next: WorkingTree) => {
      draft = structuredClone(next)
    },
    projected: () => projected,
  }
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('期望存在值，实际为 undefined')
  return value
}

const NOW = '2026-11-09T00:00:00.000Z'

async function setup(initial: WorkingTree = { p1: doc({ nodes: { n1: { x: 1 } } }) }) {
  const store = new MemoryVersionStore()
  const ws = workspace(initial)
  const service = await createVersionService(store, {
    repoId: 'r',
    readWorkingTree: () => ws.read(),
    writeWorkingTree: (next) => ws.write(next),
    now: () => NOW,
  })

  return { store, ws, service }
}

/**
 * 浏览器实测暴露过：checkout 只改内存 branch，页面刷新后静默回到 main，
 * 用户以为在 feature 上的下一次提交其实落在主干。这里钉住持久化行为。
 */
describe('VersionService HEAD 持久化', () => {
  it('检出分支后重建服务仍在该分支，提交落到该分支的 ref 上', async () => {
    const { store, ws, service } = await setup()
    const first = must(await service.commit({ message: 'c1' }))
    await service.createBranch('feature', first.id)

    const head = await service.checkout('feature', { force: true })
    expect(head.branch).toBe('feature')
    expect(head.commit).toBe(first.id)

    // 同一个 store 重建服务，等价于页面刷新 / 浏览器重开
    const restarted = await createVersionService(store, {
      repoId: 'r',
      readWorkingTree: () => ws.read(),
      writeWorkingTree: (next) => ws.write(next),
      now: () => NOW,
    })
    expect(restarted.head.branch).toBe('feature')
    expect(restarted.head.commit).toBe(first.id)

    ws.write({
      p1: doc({ nodes: { n1: { x: 2 } } }),
      p2: doc({ nodes: {} }),
    })
    const next = must(await restarted.commit({ message: 'feature c2' }))
    expect(next.parents).toEqual([first.id])
    expect((await store.getRef('r', 'refs/heads/feature'))?.target).toBe(next.id)
    expect((await store.getRef('r', 'refs/heads/main'))?.target).toBe(first.id)
  })

  it('检出到提交地址是游离 HEAD，重建后不回到原分支', async () => {
    const { store, ws, service } = await setup()
    const first = must(await service.commit({ message: 'c1' }))

    const head = await service.checkout(first.id, { force: true })
    expect(head.branch).toBeUndefined()

    const restarted = await createVersionService(store, {
      repoId: 'r',
      readWorkingTree: () => ws.read(),
      writeWorkingTree: (next) => ws.write(next),
      now: () => NOW,
    })
    expect(restarted.head.branch).toBeUndefined()
    expect(restarted.head.commit).toBe(first.id)
  })
})

describe('VersionService 提交链路', () => {
  it('首次提交是根提交；无变化时不写任何对象也不产生提交', async () => {
    const { service } = await setup()
    expect(service.head.hasUncommitted).toBe(true)

    const first = must(await service.commit({ message: '初始页面' }))
    expect(first.parents).toEqual([])
    expect(first.createdAt).toBe(NOW)
    expect(service.head.commit).toBe(first.id)
    expect(service.head.hasUncommitted).toBe(false)

    expect(await service.commit({ message: '重复提交' })).toBeUndefined()
    expect(await service.log()).toHaveLength(1)
  })

  it('脏状态由 working copy 与 HEAD 比较得出，提交后父指针正确', async () => {
    const { ws, service } = await setup()
    const first = must(await service.commit({ message: 'c1' }))

    expect((await service.refreshHead()).hasUncommitted).toBe(false)

    ws.write({ p1: doc({ nodes: { n1: { x: 2 } } }) })
    expect((await service.refreshHead()).hasUncommitted).toBe(true)

    const second = must(await service.commit({ message: 'c2' }))
    expect(second.parents).toEqual([first.id])
    expect((await service.log()).map((item) => item.id)).toEqual([second.id, first.id])
  })

  it('createdAt 不参与 commit hash', () => {
    const header = {
      repoId: 'r',
      parents: [],
      tree: { docs: {} },
      message: 'same',
      author: 'a',
      createdAt: NOW,
    }

    expect(commitIdOf(header)).toBe(
      commitIdOf({ ...header, createdAt: '2030-01-01T00:00:00.000Z' }),
    )
    expect(commitIdOf(header)).not.toBe(commitIdOf({ ...header, message: 'other' }))
  })

  /**
   * `commitIdOf` 不把 createdAt 纳入寻址，于是「同父 + 同树 + 同消息 + 同作者」的两次提交
   * 会得到同一个 id 而对象内容不同。这里钉住两个存储适配器共同的 fail-closed 行为：
   * 既不移动 ref，也不改写既有提交（IndexedDB 版曾经直接 put 覆盖 createdAt）。
   */
  it('同父同树同消息但不同时刻的两次提交撞地址时 fail-closed', async () => {
    const store = new MemoryVersionStore()
    const ws = workspace({ p1: doc({ nodes: { n1: { x: 1 } } }) })
    let tick = 0
    const service = await createVersionService(store, {
      repoId: 'r',
      readWorkingTree: () => ws.read(),
      writeWorkingTree: (next) => ws.write(next),
      now: () => `2026-11-09T00:00:0${tick++}.000Z`,
    })

    const first = must(await service.commit({ message: 'c1' }))
    await service.createBranch('b1', first.id)
    await service.createBranch('b2', first.id)

    await service.checkout('b1')
    ws.write({ p1: doc({ nodes: { n1: { x: 2 } } }) })
    const onB1 = must(await service.commit({ message: '同一份改动' }))

    await service.checkout('b2', { force: true })
    ws.write({ p1: doc({ nodes: { n1: { x: 2 } } }) })

    await expect(service.commit({ message: '同一份改动' })).rejects.toMatchObject({
      code: 'integrity',
    })
    expect((await store.getRef('r', 'refs/heads/b2'))?.target).toBe(first.id)
    expect((await store.getCommit('r', onB1.id))?.createdAt).toBe('2026-11-09T00:00:01.000Z')
  })

  it('空提交消息被拒绝', async () => {
    const { service } = await setup()

    await expect(service.commit({ message: '   ' })).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })

  it('分支隔离：在 feature 上提交不移动 main', async () => {
    const { store, ws, service } = await setup()
    const first = must(await service.commit({ message: 'c1' }))

    const branch = await service.createBranch('feature/a', first.id)
    expect(branch.base).toBe(first.id)
    expect((await service.listBranches()).map((item) => item.name)).toEqual([
      'feature/a',
      'main',
    ])

    await service.checkout('feature/a')
    expect(service.head.branch).toBe('feature/a')

    ws.write({ p1: doc({ nodes: { n1: { x: 9 } } }) })
    const second = must(await service.commit({ message: 'feature c2' }))

    expect((await store.getRef('r', 'refs/heads/main'))?.target).toBe(first.id)
    expect((await store.getRef('r', 'refs/heads/feature/a'))?.target).toBe(second.id)
    expect((await service.diff(first.id, second.id)).changes).toMatchObject([
      { entityId: 'n1', change: 'modified' },
    ])
  })

  it('检出时工作区被还原，脏工作区需显式 force', async () => {
    const { ws, service } = await setup()
    const first = must(await service.commit({ message: 'c1' }))

    ws.write({ p1: doc({ nodes: { n1: { x: 2 } } }) })
    await expect(service.checkout(first.id)).rejects.toMatchObject({ code: 'dirty-worktree' })

    await service.checkout('main', { force: true })
    expect(ws.current().p1.sections.nodes).toEqual({ n1: { x: 1 } })
    expect(service.head.hasUncommitted).toBe(false)
  })

  it('restoreDoc 只改一个文档，不立即产生提交', async () => {
    const { ws, service } = await setup()
    const first = must(await service.commit({ message: 'c1' }))

    ws.write({
      p1: doc({ nodes: { n1: { x: 2 } } }),
      p2: doc({ nodes: { n2: 1 } }),
    })
    const second = must(await service.commit({ message: 'c2' }))
    expect(Object.keys(ws.current())).toEqual(['p1', 'p2'])

    await service.restoreDoc('p1', first.id)
    expect(ws.current().p1.sections.nodes).toEqual({ n1: { x: 1 } })
    expect(ws.current().p2.sections.nodes).toEqual({ n2: 1 })
    expect(service.head.commit).toBe(second.id)
    expect(service.head.hasUncommitted).toBe(true)
    expect(await service.log()).toHaveLength(2)
  })

  it('并发前移分支时 CAS 返回冲突，而不是静默覆盖', async () => {
    const store = new MemoryVersionStore()
    const wsA = workspace({ p1: doc({ nodes: { a: 1 } }) })
    const wsB = workspace({ p1: doc({ nodes: { b: 2 } }) })
    const make = (ws: ReturnType<typeof workspace>) =>
      createVersionService(store, {
        repoId: 'r',
        readWorkingTree: () => ws.read(),
        writeWorkingTree: (next) => ws.write(next),
        now: () => NOW,
      })

    const a = await make(wsA)
    must(await a.commit({ message: 'c1' }))

    const b = await make(wsB)
    must(await b.commit({ message: 'c2' }))

    wsA.write({ p1: doc({ nodes: { a: 3 } }) })
    await expect(a.commit({ message: 'c3' })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('受保护分支拒绝直接提交（判定在写入路径）', async () => {
    const { store, service } = await setup()
    await store.putBranchMeta('r', { name: 'main', protected: true, base: '' })

    await expect(service.commit({ message: 'c1' })).rejects.toMatchObject({ code: 'protected' })
  })

  it('事件按 commit/ref/head 顺序发出，dispose 后不再收到', async () => {
    const { ws, service } = await setup()
    const kinds: string[] = []
    const subscription = service.onDidChange((event) => kinds.push(event.kind))

    await service.commit({ message: 'c1' })
    expect(kinds).toEqual(['commit', 'ref', 'head'])

    subscription.dispose()
    ws.write({ p1: doc({ nodes: { n1: { x: 2 } } }) })
    await service.refreshHead()
    expect(kinds).toEqual(['commit', 'ref', 'head'])
  })
})

/**
 * 宿主写不回工作区时的检出语义。
 *
 * 浏览器实测暴露过：面板检出另一条分支只是「看一眼历史」，草稿并未跟着切换，
 * 但内核把 HEAD 移过去且报干净，于是下一次保存把草稿提交到了刚检出的分支上。
 */
describe('VersionService 只读查看态', () => {
  async function viewOnlySetup() {
    const store = new MemoryVersionStore()
    const ws = projectedWorkspace({ p1: doc({ nodes: { n1: { x: 1 } } }) })
    const options: VersionServiceOptions = {
      repoId: 'r',
      readWorkingTree: () => ws.read(),
      writeWorkingTree: (next) => ws.write(next),
      now: () => NOW,
      workingTreeReplaceable: false,
    }
    const service = await createVersionService(store, options)

    return { store, ws, options, service }
  }

  it('检出另一条分支后拒绝提交，草稿不会落到该分支的 ref 上', async () => {
    const { store, ws, service } = await viewOnlySetup()
    const first = must(await service.commit({ message: 'c1' }))
    await service.createBranch('feature', first.id)

    // 两条分支指向同一个提交：只比提交会漏掉这次改道，必须按分支判
    ws.setDraft({ p1: doc({ nodes: { n1: { x: 2 } } }) })
    const head = await service.checkout('feature', { force: true })
    expect(head.branch).toBe('feature')
    expect(head.hasUncommitted).toBe(true)
    expect(ws.projected()?.p1.sections.nodes).toEqual({ n1: { x: 1 } })

    await expect(service.commit({ message: '误提交' })).rejects.toMatchObject({
      code: 'read-only-view',
    })
    expect((await store.getRef('r', 'refs/heads/feature'))?.target).toBe(first.id)
  })

  it('检出回工作分支后提交恢复，且落到工作分支', async () => {
    const { store, ws, service } = await viewOnlySetup()
    const first = must(await service.commit({ message: 'c1' }))
    await service.createBranch('feature', first.id)

    await service.checkout('feature', { force: true })
    await service.checkout('main', { force: true })
    expect(service.head.branch).toBe('main')
    expect(service.head.hasUncommitted).toBe(false)

    ws.setDraft({ p1: doc({ nodes: { n1: { x: 3 } } }) })
    const next = must(await service.commit({ message: 'c2' }))
    expect(next.parents).toEqual([first.id])
    expect((await store.getRef('r', 'refs/heads/main'))?.target).toBe(next.id)
    expect((await store.getRef('r', 'refs/heads/feature'))?.target).toBe(first.id)
  })

  it('查看态不持久化 HEAD，重建服务回到工作分支而不是看过的分支', async () => {
    const { store, ws, options, service } = await viewOnlySetup()
    const first = must(await service.commit({ message: 'c1' }))
    await service.createBranch('feature', first.id)
    await service.checkout('feature', { force: true })

    // 等价于用户看着历史关掉了浏览器
    const restarted = await createVersionService(store, options)
    expect(restarted.head.branch).toBe('main')
    expect(restarted.head.commit).toBe(first.id)

    ws.setDraft({ p1: doc({ nodes: { n1: { x: 5 } } }) })
    const next = must(await restarted.commit({ message: 'c2' }))
    expect((await store.getRef('r', 'refs/heads/main'))?.target).toBe(next.id)
    expect((await store.getRef('r', 'refs/heads/feature'))?.target).toBe(first.id)
  })

  it('写不回工作区时拒绝 restoreDoc 与 merge，但合并预览仍可用', async () => {
    const { service } = await viewOnlySetup()
    const first = must(await service.commit({ message: 'c1' }))
    await service.createBranch('feature', first.id)

    await expect(service.restoreDoc('p1', first.id)).rejects.toMatchObject({
      code: 'read-only-view',
    })
    await expect(service.merge('feature')).rejects.toMatchObject({ code: 'read-only-view' })

    const plan = await service.mergePreview('feature')
    expect(plan.conflicts).toEqual([])
  })

  /**
   * 面板要靠 head 把「执行合并」「提交」置灰并说明原因，而不是让用户点了才吃
   * `read-only-view`。所以这三个字段是 UI 的输入，必须由内核给出、不能在面板里推导。
   */
  it('head 暴露置灰按钮所需的状态：可替换性、查看态与工作区归属分支', async () => {
    const { service } = await viewOnlySetup()
    const first = must(await service.commit({ message: 'c1' }))
    await service.createBranch('feature', first.id)

    expect(service.head).toMatchObject({
      branch: 'main',
      workingTreeReplaceable: false,
      viewOnly: false,
      draftBranch: 'main',
    })

    await service.checkout('feature', { force: true })
    expect(service.head).toMatchObject({
      branch: 'feature',
      workingTreeReplaceable: false,
      viewOnly: true,
      draftBranch: 'main',
    })

    await service.checkout('main', { force: true })
    expect(service.head).toMatchObject({
      branch: 'main',
      viewOnly: false,
      draftBranch: 'main',
    })
  })

  it('可替换工作区时 head 报告完整写权限，检出后不进入查看态', async () => {
    const { service } = await setup()
    const first = must(await service.commit({ message: 'c1' }))
    await service.createBranch('feature', first.id)

    expect(service.head).toMatchObject({
      workingTreeReplaceable: true,
      viewOnly: false,
      draftBranch: 'main',
    })

    await service.checkout('feature')
    expect(service.head).toMatchObject({
      branch: 'feature',
      workingTreeReplaceable: true,
      viewOnly: false,
      draftBranch: 'feature',
    })
  })
})
