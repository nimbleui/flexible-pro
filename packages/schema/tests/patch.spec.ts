import { describe, expect, it } from 'vitest'
import { applyPatches, getAtPath, isNodePatch, nodePath } from '../src/patch'
import type { PageSchema } from '../src/page'
import { SCHEMA_VERSION } from '../src/version'

function createSchema(): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        componentName: 'Box',
        layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 100, height: 50 } },
      },
    },
    components: [],
  }
}

describe('schema patch', () => {
  it('不可变更新嵌套字段，原对象保持引用不变', () => {
    const schema = createSchema()
    const next = applyPatches(schema, [
      { op: 'replace', path: '/nodes/root/layout/rect/x', value: 40 },
    ])

    expect(next).not.toBe(schema)
    expect(next.nodes.root?.layout?.rect?.x).toBe(40)
    expect(schema.nodes.root?.layout?.rect?.x).toBe(0)
    // 未触碰的分支共享引用
    expect(next.nodes.root?.layout?.mode).toBe(schema.nodes.root?.layout?.mode)
  })

  it('支持数组下标与 remove', () => {
    const schema = createSchema()
    schema.nodes.root!.children = ['a', 'b', 'c']

    const next = applyPatches(schema, [{ op: 'remove', path: '/nodes/root/children/1' }])
    expect(next.nodes.root?.children).toEqual(['a', 'c'])
  })

  it('路径不存在时创建中间对象', () => {
    const schema = createSchema()
    const next = applyPatches(schema, [
      { op: 'add', path: '/nodes/root/layout/rotate', value: 15 },
    ])

    expect(next.nodes.root?.layout?.rotate).toBe(15)
  })

  it('getAtPath 读取节点几何', () => {
    const schema = createSchema()
    expect(getAtPath(schema, '/nodes/root/layout/rect/width')).toBe(100)
    expect(getAtPath(schema, '/nodes/missing')).toBeUndefined()
  })

  it('节点 patch 路径判定', () => {
    expect(isNodePatch({ op: 'replace', path: nodePath('n1', 'layout') })).toBe(true)
    expect(isNodePatch({ op: 'replace', path: '/components/0/meta/title' })).toBe(false)
  })

  it('非法路径直接抛错', () => {
    expect(() =>
      applyPatches(createSchema(), [{ op: 'add', path: 'nodes/root', value: 1 }]),
    ).toThrow(/必须以/)
  })
})
