import type { VersionDocument } from '@lc/contracts'
import { canonicalJson } from '@lc/shared'
import { describe, expect, it } from 'vitest'
import { buildTree, createSectionObject, readDocument } from '../src/object'
import { VersionError } from '../src/errors'
import { MemoryVersionStore } from '../src/store/memory'

function doc(sections: Record<string, unknown>): VersionDocument {
  return { kind: 'page', docSchemaVersion: '1.0.0', sections }
}

describe('内容寻址对象', () => {
  it('键序不同但内容相同时 section hash 相同', () => {
    const a = createSectionObject('p1', 'nodes', { n1: { x: 1, y: 2 } })
    const b = createSectionObject('p1', 'nodes', { n1: { y: 2, x: 1 } })

    expect(a.hash).toBe(b.hash)
    expect(a.content).toBe(b.content)
    expect(a.size).toBeGreaterThan(0)
  })

  it('数组换序属于内容变化，hash 必须不同', () => {
    const a = createSectionObject('p1', 'nodes', { n1: { children: ['a', 'b'] } })
    const b = createSectionObject('p1', 'nodes', { n1: { children: ['b', 'a'] } })

    expect(a.hash).not.toBe(b.hash)
  })

  it('不同文档 / section 的同值内容取址不同，不会触发 integrity 误报', async () => {
    const store = new MemoryVersionStore()
    const a = createSectionObject('p1', 'nodes', {})
    const b = createSectionObject('p2', 'edges', {})

    expect(a.content).toBe(b.content)
    expect(a.hash).not.toBe(b.hash)

    await store.putObject('r', a)
    await expect(store.putObject('r', b)).resolves.toBeUndefined()
  })

  it('buildTree 对文档与 section 的插入顺序不敏感', () => {
    const a = buildTree({ p2: doc({ nodes: { b: 1 } }), p1: doc({ nodes: { a: 1 } }) })
    const b = buildTree({ p1: doc({ nodes: { a: 1 } }), p2: doc({ nodes: { b: 1 } }) })

    expect(canonicalJson(a.commitTree)).toBe(canonicalJson(b.commitTree))
  })

  it('未变 section 复用同一地址，改一个 section 只换一个地址', () => {
    const before = buildTree({ p1: doc({ nodes: { n1: 1 }, actions: { a1: 1 } }) })
    const after = buildTree({ p1: doc({ nodes: { n1: 2 }, actions: { a1: 1 } }) })

    const sectionOf = (objects: typeof before.objects, name: string) =>
      objects.find((object) => object.kind === 'section' && object.section === name)?.hash

    expect(sectionOf(before.objects, 'actions')).toBe(sectionOf(after.objects, 'actions'))
    expect(sectionOf(before.objects, 'nodes')).not.toBe(sectionOf(after.objects, 'nodes'))
    expect(before.commitTree.docs.p1).not.toBe(after.commitTree.docs.p1)
  })

  it('putObject 幂等；同 hash 不同内容必须抛 integrity', async () => {
    const store = new MemoryVersionStore()
    const object = createSectionObject('p1', 'nodes', { n1: 1 })

    await store.putObject('r', object)
    await store.putObject('r', object)
    expect(await store.hasObject('r', object.hash)).toBe(true)

    const impostor = { ...object, content: '{"other":true}' }
    await expect(store.putObject('r', impostor)).rejects.toMatchObject({ code: 'integrity' })
  })

  it('写入后修改外部引用不会改变库内对象', async () => {
    const store = new MemoryVersionStore()
    const object = createSectionObject('p1', 'nodes', { n1: 1 })
    await store.putObject('r', object)

    Object.assign(object, { content: 'mutated' })

    expect((await store.getObject('r', object.hash))?.kind).toBe('section')
    expect(
      await store
        .getObject('r', object.hash)
        .then((stored) => (stored?.kind === 'section' ? stored.content : '')),
    ).toBe('{"n1":1}')
  })

  it('readDocument 往返还原 section 值', async () => {
    const store = new MemoryVersionStore()
    const tree = { p1: doc({ nodes: { n1: { x: 1 } }, route: { path: '/home' } }) }
    const { objects, commitTree } = buildTree(tree)

    for (const object of objects) await store.putObject('r', object)

    const restored = await readDocument(store, 'r', commitTree.docs.p1)
    expect(restored.kind).toBe('page')
    expect(restored.sections.nodes).toEqual({ n1: { x: 1 } })
    expect(restored.sections.route).toEqual({ path: '/home' })
  })

  it('缺对象时抛结构化错误而不是返回空文档', async () => {
    const store = new MemoryVersionStore()

    await expect(readDocument(store, 'r', 'missing')).rejects.toBeInstanceOf(VersionError)
  })
})
