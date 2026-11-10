import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DOC_SCHEMA_VERSION,
  fromWorkingTree,
  toWorkingTree,
  type VersionAssetSnapshot,
} from '../src/projection'

const snapshot: VersionAssetSnapshot = {
  records: [
    { id: 'p2', kind: 'page', content: { nodes: { n2: 2 } } },
    {
      id: 'p1',
      kind: 'flow',
      docSchemaVersion: '2.0.0',
      content: { definition: { steps: ['a'] } },
    },
  ],
}

describe('资产投影', () => {
  it('toWorkingTree 按 id 排序并补齐结构版本', () => {
    const tree = toWorkingTree(snapshot)

    expect(Object.keys(tree)).toEqual(['p1', 'p2'])
    expect(tree.p1.kind).toBe('flow')
    expect(tree.p1.docSchemaVersion).toBe('2.0.0')
    expect(tree.p2.docSchemaVersion).toBe(DEFAULT_DOC_SCHEMA_VERSION)
    expect(tree.p2.sections.nodes).toEqual({ n2: 2 })
  })

  it('往返投影保持内容，且缺省版本显式化', () => {
    const restored = fromWorkingTree(toWorkingTree(snapshot))

    expect(restored.records).toEqual([
      {
        id: 'p1',
        kind: 'flow',
        docSchemaVersion: '2.0.0',
        content: { definition: { steps: ['a'] } },
      },
      {
        id: 'p2',
        kind: 'page',
        docSchemaVersion: DEFAULT_DOC_SCHEMA_VERSION,
        content: { nodes: { n2: 2 } },
      },
    ])
  })

  it('投影不共享输入对象的引用，避免宿主后续修改污染工作区', () => {
    const input: VersionAssetSnapshot = {
      records: [{ id: 'p1', kind: 'page', content: { nodes: { n1: 1 } } }],
    }
    const tree = toWorkingTree(input)

    expect(tree.p1.sections).not.toBe(input.records[0].content)
    expect(toWorkingTree(input).p1.docSchemaVersion).toBe(DEFAULT_DOC_SCHEMA_VERSION)
  })
})
