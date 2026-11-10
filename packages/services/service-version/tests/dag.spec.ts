import type { Commit } from '@lc/contracts'
import { describe, expect, it } from 'vitest'
import { collectCommits, isAncestor, logCommits, mergeBases } from '../src/dag'
import { MemoryVersionStore } from '../src/store/memory'

function commit(id: string, parents: string[] = []): Commit {
  return {
    id,
    repoId: 'r',
    parents,
    tree: { docs: {} },
    message: id,
    author: 'test',
    createdAt: '2026-11-09T00:00:00.000Z',
  }
}

async function storeWith(...commits: Commit[]): Promise<MemoryVersionStore> {
  const store = new MemoryVersionStore()
  for (const item of commits) await store.putCommit('r', item)
  return store
}

describe('commit DAG', () => {
  it('log 默认沿第一父链，分页生效', async () => {
    const store = await storeWith(commit('r'), commit('a', ['r']), commit('b', ['a']))

    expect((await logCommits(store, 'r', 'b')).map((item) => item.id)).toEqual(['b', 'a', 'r'])
    expect((await logCommits(store, 'r', 'b', { limit: 2 })).map((item) => item.id)).toEqual([
      'b',
      'a',
    ])
    expect(
      (await logCommits(store, 'r', 'b', { offset: 1, limit: 1 })).map((item) => item.id),
    ).toEqual(['a'])
  })

  it('firstParent=false 展开被合并进来的第二父链', async () => {
    const store = await storeWith(
      commit('r'),
      commit('a', ['r']),
      commit('b', ['r']),
      commit('m', ['a', 'b']),
    )

    expect((await logCommits(store, 'r', 'm')).map((item) => item.id)).toEqual(['m', 'a', 'r'])
    expect(
      (await logCommits(store, 'r', 'm', { firstParent: false })).map((item) => item.id),
    ).toEqual(['m', 'a', 'b', 'r'])
  })

  it('单 LCA 返回分叉点', async () => {
    const store = await storeWith(
      commit('r'),
      commit('a', ['r']),
      commit('b', ['r']),
      commit('c', ['a']),
    )

    expect(await mergeBases(store, 'r', 'b', 'c')).toEqual(['r'])
  })

  it('criss-cross 返回全部极大元，不伪造虚拟基线', async () => {
    const store = await storeWith(
      commit('r'),
      commit('a', ['r']),
      commit('b', ['r']),
      commit('m1', ['a', 'b']),
      commit('m2', ['b', 'a']),
    )

    expect(await mergeBases(store, 'r', 'm1', 'm2')).toEqual(['a', 'b'])
  })

  it('isAncestor 在合并图上沿全部父链可达', async () => {
    const store = await storeWith(
      commit('r'),
      commit('a', ['r']),
      commit('b', ['r']),
      commit('m', ['a', 'b']),
    )
    const commits = await collectCommits(store, 'r', ['m'])

    expect(isAncestor(commits, 'b', 'm')).toBe(true)
    expect(isAncestor(commits, 'a', 'b')).toBe(false)
    expect(isAncestor(commits, 'm', 'm')).toBe(true)
  })

  it('父提交缺失时抛错，不静默截断历史', async () => {
    const store = await storeWith(commit('b', ['missing']))

    await expect(logCommits(store, 'r', 'b')).rejects.toMatchObject({ code: 'missing-commit' })
  })

  it('空仓库的 log 返回空数组', async () => {
    const store = new MemoryVersionStore()

    expect(await logCommits(store, 'r', '')).toEqual([])
  })
})
