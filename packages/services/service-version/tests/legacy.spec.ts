import { describe, expect, it } from 'vitest'
import { importLegacyReleases, type LegacyReleaseSnapshot } from '../src/legacy'
import { MemoryVersionStore } from '../src/store/memory'

const release = (revision: number): LegacyReleaseSnapshot => ({
  revision,
  createdAt: `2026-01-0${revision}T00:00:00.000Z`,
  assets: {
    records: [{ id: 'p1', kind: 'page', content: { nodes: { root: revision } } }],
  },
  environment: { baseUrl: `https://v${revision}.example.com` },
})

const imports = [release(1), release(2), release(3)]

describe('存量发布导入', () => {
  it('按发布号生成 commit 链、tag 与 main 指针', async () => {
    const store = new MemoryVersionStore()
    const result = await importLegacyReleases(store, 'r', imports)

    expect(result.commits).toHaveLength(3)
    expect(result.commits[0].parents).toEqual([])
    expect(result.commits[1].parents).toEqual([result.commits[0].id])
    expect(result.commits[2].parents).toEqual([result.commits[1].id])
    expect(result.tags.map((item) => item.name)).toEqual([
      'refs/tags/v1',
      'refs/tags/v2',
      'refs/tags/v3',
    ])
    expect(result.mainTarget).toBe(result.commits[2].id)
    expect((await store.getRef('r', 'refs/heads/main'))?.target).toBe(result.mainTarget)
  })

  it('导入提交带 PublishReceipt，标明是发布粒度', async () => {
    const store = new MemoryVersionStore()
    const result = await importLegacyReleases(store, 'r', [release(1)])

    expect(result.commits[0].message).toBe('导入存量 v1')
    expect(result.commits[0].publish).toMatchObject({
      label: 'v1',
      issues: [],
      publishedBy: 'migration',
    })
    expect(result.commits[0].publish?.environmentHash).toMatch(/^[0-9a-f]{40}$/)
  })

  it('重跑幂等，不产生新提交也不覆盖 main', async () => {
    const store = new MemoryVersionStore()
    const first = await importLegacyReleases(store, 'r', imports)
    const second = await importLegacyReleases(store, 'r', imports)

    expect(second.commits).toEqual([])
    expect(second.tags).toEqual([])
    expect(second.mainTarget).toBe(first.mainTarget)
    expect((await store.scanObjectHashes('r')).length).toBeGreaterThan(0)
  })

  it('main 已存在时不覆盖已有版本库', async () => {
    const store = new MemoryVersionStore()
    await store.casRef('r', 'refs/heads/main', undefined, 'existing-head')

    const result = await importLegacyReleases(store, 'r', [release(1)])
    expect(result.mainTarget).toBe('existing-head')
    expect((await store.getRef('r', 'refs/heads/main'))?.target).toBe('existing-head')
  })

  it('tag 已指向别的内容时抛 integrity，不静默改写', async () => {
    const store = new MemoryVersionStore()
    await store.casRef('r', 'refs/tags/v1', undefined, 'other-target')

    await expect(importLegacyReleases(store, 'r', [release(1)])).rejects.toMatchObject({
      code: 'integrity',
    })
  })

  it('没有发布时不动任何 ref', async () => {
    const store = new MemoryVersionStore()
    const result = await importLegacyReleases(store, 'r', [])

    expect(result).toEqual({ commits: [], tags: [], mainTarget: undefined })
    expect(await store.listRefs('r')).toEqual([])
  })
})
