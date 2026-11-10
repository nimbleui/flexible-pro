import type { MergeValidate, WorkingTree } from '@lc/contracts'
import { describe, expect, it } from 'vitest'
import { createVersionService } from '../src/service'
import { MemoryVersionStore } from '../src/store/memory'

/**
 * 合并的端到端链路：真实对象存储 + 真实 ref CAS + 真实工作区桥接。
 * 纯算法的不变式由 `merge.spec.ts` 覆盖，这里只钉住「预览 / 落盘 / 不落盘」的边界。
 */

const NOW = '2026-11-09T12:00:00.000Z'
const DOC = 'page:p1'

function page(nodes: Record<string, unknown>): WorkingTree {
  return {
    [DOC]: {
      kind: 'page',
      docSchemaVersion: '1.0.0',
      sections: { version: '1.0.0', nodes },
    },
  }
}

function nodesOf(tree: WorkingTree): Record<string, unknown> {
  const nodes = tree[DOC]?.sections.nodes
  return typeof nodes === 'object' && nodes !== null && !Array.isArray(nodes)
    ? (nodes as Record<string, unknown>)
    : {}
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('期望存在值，实际为 undefined')
  return value
}

async function setup(initial: WorkingTree, validate?: MergeValidate) {
  const store = new MemoryVersionStore()
  let tree = structuredClone(initial)
  const service = await createVersionService(store, {
    repoId: 'r',
    readWorkingTree: () => structuredClone(tree),
    writeWorkingTree: (next) => {
      tree = structuredClone(next)
    },
    now: () => NOW,
    validate,
  })

  return {
    store,
    service,
    getTree: () => structuredClone(tree),
    setTree: (next: WorkingTree) => {
      tree = structuredClone(next)
    },
  }
}

type Context = Awaited<ReturnType<typeof setup>>

/** 在 base 上开 `feature`，两侧各自提交一次，最后切回 main。 */
async function fork(
  ctx: Context,
  mainTree: WorkingTree,
  featureTree: WorkingTree,
): Promise<string> {
  const base = await ctx.service.commit({ message: 'base' })
  expect(base).toBeDefined()
  const baseId = ctx.service.head.commit

  await ctx.service.createBranch('feature', baseId)
  ctx.setTree(mainTree)
  await ctx.service.commit({ message: 'main' })

  await ctx.service.checkout('feature')
  ctx.setTree(featureTree)
  await ctx.service.commit({ message: 'feature' })

  await ctx.service.checkout('main')
  return baseId
}

describe('合并链路', () => {
  it('两人各加一页 / 同页各加节点：干净合并生成双亲提交', async () => {
    const initial = page({ n1: { id: 'n1' } })
    const ctx = await setup(initial)
    await fork(
      ctx,
      page({ n1: { id: 'n1' }, n2: { id: 'n2' } }),
      page({ n1: { id: 'n1' }, n3: { id: 'n3' } }),
    )

    const preview = await ctx.service.mergePreview('feature')
    expect(preview.status).toBe('clean')
    expect(preview.conflicts).toEqual([])
    expect(preview.validation).toBe('skipped')
    expect(preview.bases.length).toBeGreaterThan(0)

    const result = await ctx.service.merge('feature')
    expect(result.status).toBe('merged')
    expect(result.commit?.parents).toEqual([preview.ours, preview.theirs])
    expect(Object.keys(nodesOf(ctx.getTree())).sort()).toEqual(['n1', 'n2', 'n3'])
    expect(ctx.service.head.commit).toBe(result.commit?.id)
    expect((await ctx.service.log()).length).toBeGreaterThanOrEqual(3)
  })

  it('同字段冲突：预览与合并不写任何对象，全部裁决后才落盘', async () => {
    const ctx = await setup(page({ n1: { id: 'n1', x: 1 } }))
    await fork(ctx, page({ n1: { id: 'n1', x: 2 } }), page({ n1: { id: 'n1', x: 3 } }))

    const preview = await ctx.service.mergePreview('feature')
    expect(preview.status).toBe('conflicted')
    expect(preview.conflicts.length).toBeGreaterThan(0)

    const before = ctx.service.head.commit
    const blocked = await ctx.service.merge('feature')
    expect(blocked.status).toBe('conflicted')
    expect(ctx.service.head.commit).toBe(before)

    const resolutions = preview.conflicts.map((conflict) => ({
      conflictId: conflict.id,
      choice: 'theirs' as const,
    }))
    const merged = await ctx.service.merge('feature', { resolutions })
    expect(merged.status).toBe('merged')
    expect(nodesOf(ctx.getTree()).n1).toEqual({ id: 'n1', x: 3 })
  })

  it('目标已是祖先返回 up-to-date；可快进时移动 ref 而不造合并提交', async () => {
    const ctx = await setup(page({ n1: { id: 'n1' } }))
    const baseId = await fork(
      ctx,
      page({ n1: { id: 'n1' }, n2: { id: 'n2' } }),
      page({ n1: { id: 'n1' }, n3: { id: 'n3' } }),
    )

    const upToDate = await ctx.service.merge(baseId)
    expect(upToDate.status).toBe('up-to-date')
    expect(upToDate.commit).toBeUndefined()

    const ff = await setup(page({ n1: { id: 'n1' } }))
    const root = await ff.service.commit({ message: 'base' })
    expect(root).toBeDefined()
    await ff.service.createBranch('feature', ff.service.head.commit)
    await ff.service.checkout('feature')
    ff.setTree(page({ n1: { id: 'n1' }, n2: { id: 'n2' } }))
    const featureCommit = await ff.service.commit({ message: 'feature' })
    await ff.service.checkout('main')

    const before = ff.service.head.commit
    const result = await ff.service.merge('feature')
    expect(result.status).toBe('fast-forward')
    expect(result.target).toBe(featureCommit?.id)
    expect(result.commit).toBeUndefined()
    expect(ff.service.head.commit).not.toBe(before)
    expect(ff.service.head.commit).toBe(featureCommit?.id)
  })

  it('受保护分支拒绝直接提交但接受合并提交', async () => {
    const ctx = await setup(page({ n1: { id: 'n1' } }))
    const root = await ctx.service.commit({ message: 'base' })
    expect(root).toBeDefined()
    const baseId = ctx.service.head.commit
    await ctx.service.createBranch('feature', baseId)

    ctx.setTree(page({ n1: { id: 'n1' }, n2: { id: 'n2' } }))
    await ctx.service.commit({ message: 'main' })
    await ctx.store.putBranchMeta('r', { name: 'main', protected: true, base: baseId })

    await ctx.service.checkout('feature')
    ctx.setTree(page({ n1: { id: 'n1' }, n3: { id: 'n3' } }))
    await ctx.service.commit({ message: 'feature' })
    await ctx.service.checkout('main')

    await expect(ctx.service.commit({ message: '不允许' })).rejects.toThrow(/受保护/)
    const result = await ctx.service.merge('feature')
    expect(result.status).toBe('merged')
    expect(result.commit?.parents).toHaveLength(2)
  })

  it('工作区有未提交内容时拒绝合并，注入校验器报 error 时返回 invalid', async () => {
    const ctx = await setup(page({ n1: { id: 'n1' } }))
    await fork(
      ctx,
      page({ n1: { id: 'n1' }, n2: { id: 'n2' } }),
      page({ n1: { id: 'n1' }, n3: { id: 'n3' } }),
    )

    ctx.setTree(page({ n1: { id: 'n1' }, dirty: true }))
    await expect(ctx.service.merge('feature')).rejects.toThrow(/未提交内容/)

    const invalid = await setup(page({ n1: { id: 'n1' } }), () => [
      { path: '/nodes', message: '合并产物不合法', severity: 'error' },
    ])
    await fork(
      invalid,
      page({ n1: { id: 'n1' }, n2: { id: 'n2' } }),
      page({ n1: { id: 'n1' }, n3: { id: 'n3' } }),
    )
    const preview = await invalid.service.mergePreview('feature')
    expect(preview.validation).toBe('failed')
    expect(preview.status).toBe('invalid')

    const before = invalid.service.head.commit
    const blocked = await invalid.service.merge('feature')
    expect(blocked.status).toBe('invalid')
    expect(invalid.service.head.commit).toBe(before)
  })

  it('提交里显式记录的改名意图会被另一侧自动跟进', async () => {
    const ctx = await setup(page({ n1: { id: 'n1' }, n2: { id: 'n2' } }))
    const root = await ctx.service.commit({ message: 'base' })
    expect(root).toBeDefined()
    const baseId = ctx.service.head.commit
    await ctx.service.createBranch('feature', baseId)

    ctx.setTree(page({ n1: { id: 'n1' }, n2: { id: 'n2' }, n4: { id: 'n4' } }))
    await ctx.service.commit({ message: 'main' })

    await ctx.service.checkout('feature')
    ctx.setTree(page({ n9: { id: 'n9' }, n2: { id: 'n2' } }))
    await ctx.service.commit({
      message: 'rename n1 to n9',
      intents: [{ from: 'n1', to: 'n9', docId: DOC, section: 'nodes' }],
    })
    await ctx.service.checkout('main')

    const preview = await ctx.service.mergePreview('feature')
    expect(preview.status).toBe('clean')
    expect(preview.appliedIntents).toHaveLength(1)

    const result = await ctx.service.merge('feature')
    expect(result.status).toBe('merged')
    const nodes = nodesOf(ctx.getTree())
    expect(nodes.n1).toBeUndefined()
    expect(nodes.n9).toEqual({ id: 'n9' })
    expect(nodes.n4).toEqual({ id: 'n4' })
  })

  it('校验器无问题时允许合并；criss-cross 把两个 LCA 折叠成不落盘的虚拟基线', async () => {
    const ok = await setup(page({ n1: { id: 'n1' } }), () => [])
    await fork(
      ok,
      page({ n1: { id: 'n1' }, n2: { id: 'n2' } }),
      page({ n1: { id: 'n1' }, n3: { id: 'n3' } }),
    )
    const preview = await ok.service.mergePreview('feature')
    expect(preview.validation).toBe('passed')
    expect(preview.status).toBe('clean')
    expect((await ok.service.merge('feature')).status).toBe('merged')

    // M_A = [A1, B1]、M_B = [B2, A1]，两者的极大 LCA 是 {A1, B1} 两个
    const ctx = await setup(page({ n0: { id: 'n0' } }))
    await ctx.service.commit({ message: 'root' })
    const root = ctx.service.head.commit
    await ctx.service.createBranch('a', root)
    await ctx.service.createBranch('b', root)

    await ctx.service.checkout('a')
    ctx.setTree(page({ n0: { id: 'n0' }, a1: { id: 'a1' } }))
    const a1 = must(await ctx.service.commit({ message: 'A1' }))

    await ctx.service.checkout('b')
    ctx.setTree(page({ n0: { id: 'n0' }, b1: { id: 'b1' } }))
    await ctx.service.commit({ message: 'B1' })

    await ctx.service.checkout('a')
    expect((await ctx.service.merge('b')).status).toBe('merged')

    await ctx.service.checkout('b')
    ctx.setTree(page({ n0: { id: 'n0' }, b1: { id: 'b1' }, b2: { id: 'b2' } }))
    await ctx.service.commit({ message: 'B2' })
    const mb = await ctx.service.merge(a1.id)
    expect(mb.status).toBe('merged')

    await ctx.service.checkout('a')
    const plan = await ctx.service.mergePreview(must(mb.commit).id)
    expect(plan.bases).toHaveLength(2)
    expect(plan.status).toBe('clean')
    expect(nodesOf(plan.tree).b2).toBeDefined()
    expect((await ctx.service.merge(must(mb.commit).id)).status).toBe('merged')
  })
})
