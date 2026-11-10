import type { VersionDocument, WorkingTree } from '@lc/contracts'
import { describe, expect, it } from 'vitest'
import { diffTrees, entityMapOf } from '../src/diff'
import { buildTree } from '../src/object'
import { MemoryVersionStore } from '../src/store/memory'

function doc(sections: Record<string, unknown>): VersionDocument {
  return { kind: 'page', docSchemaVersion: '1.0.0', sections }
}

async function trees(before: WorkingTree, after: WorkingTree) {
  const store = new MemoryVersionStore()
  const a = buildTree(before)
  const b = buildTree(after)

  for (const object of [...a.objects, ...b.objects]) await store.putObject('r', object)

  return { store, from: a.commitTree, to: b.commitTree }
}

async function changes(before: WorkingTree, after: WorkingTree) {
  const { store, from, to } = await trees(before, after)
  return diffTrees(store, 'r', from, to, 'before', 'after')
}

describe('实体级 diff', () => {
  it('字典 section 按 id 分辨增删改', async () => {
    const result = await changes(
      { p1: doc({ nodes: { keep: 1, removed: 2, changed: 3 } }) },
      { p1: doc({ nodes: { keep: 1, added: 4, changed: 9 } }) },
    )

    expect(result.changes).toEqual([
      { docId: 'p1', section: 'nodes', entityId: 'added', change: 'added', ours: 4 },
      {
        docId: 'p1',
        section: 'nodes',
        entityId: 'changed',
        change: 'modified',
        base: 3,
        ours: 9,
      },
      { docId: 'p1', section: 'nodes', entityId: 'removed', change: 'removed', base: 2 },
    ])
    expect(result.unchangedDocs).toEqual([])
  })

  it('数组按稳定 id 转字典：换序不产生改动', async () => {
    const result = await changes(
      {
        p1: doc({
          children: [
            { id: 'a', x: 1 },
            { id: 'b', x: 2 },
          ],
        }),
      },
      {
        p1: doc({
          children: [
            { id: 'b', x: 2 },
            { id: 'a', x: 1 },
          ],
        }),
      },
    )

    expect(result.changes).toEqual([])
    // 对象 hash 仍按数组顺序定址，因此这里不算 unchangedDocs；
    // diff 层按稳定 id 归一化后无实体改动，两层语义不同但都成立。
    expect(result.unchangedDocs).toEqual([])
  })

  it('数组元素改字段时报 modified，且 entityId 是元素 id', async () => {
    const result = await changes(
      { p1: doc({ children: [{ id: 'a', x: 1 }] }) },
      { p1: doc({ children: [{ id: 'a', x: 2 }] }) },
    )

    expect(result.changes).toMatchObject([{ entityId: 'a', change: 'modified' }])
  })

  it('叶子字段 section 用 JSON Pointer 风格 id', async () => {
    const result = await changes(
      { p1: doc({ route: { path: '/home', title: 'a' } }) },
      { p1: doc({ route: { path: '/about', title: 'a' } }) },
    )

    expect(result.changes).toMatchObject([{ entityId: '/path', change: 'modified' }])
  })

  it('整篇新增/删除列入 docs 清单并逐实体展开', async () => {
    const added = await changes({}, { p1: doc({ nodes: { n1: 1 } }) })
    expect(added.addedDocs).toEqual(['p1'])
    expect(added.changes).toMatchObject([{ entityId: 'n1', change: 'added' }])

    const removed = await changes({ p1: doc({ nodes: { n1: 1 } }) }, {})
    expect(removed.removedDocs).toEqual(['p1'])
    expect(removed.changes).toMatchObject([{ entityId: 'n1', change: 'removed' }])
  })

  it('对象键序不同但内容相同时不算改动', async () => {
    const result = await changes(
      { p1: doc({ nodes: { n1: { x: 1, y: 2 } } }) },
      { p1: doc({ nodes: { n1: { y: 2, x: 1 } } }) },
    )

    expect(result.changes).toEqual([])
    expect(result.unchangedDocs).toEqual(['p1'])
  })

  it('entityMapOf 对无稳定键的数组回退索引，重复键加后缀', () => {
    expect([...entityMapOf('children', [{ id: 'x' }, 1, 2]).keys()]).toEqual(['x', '#1', '#2'])
    expect([...entityMapOf('children', [{ name: 'a' }, { name: 'a' }]).keys()]).toEqual([
      'a',
      'a#2',
    ])
  })
})
