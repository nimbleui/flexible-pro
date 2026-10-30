import type { NodeSchema, PageSchema } from '@lc/schema'
import { SCHEMA_VERSION, applyPatches } from '@lc/schema'
import { describe, expect, it } from 'vitest'
import {
  copySubtrees,
  deleteSelection,
  insertSubtrees,
  nudgeSelection,
} from '../src/operations'

function node(id: string, rect: { x: number; y: number }): NodeSchema {
  return {
    id,
    componentName: 'Box',
    layout: { mode: 'absolute', rect: { ...rect, width: 100, height: 60 } },
  }
}

function createSchema(): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'board',
    nodes: {
      board: {
        ...node('board', { x: 0, y: 0 }),
        children: ['card'],
      },
      card: {
        ...node('card', { x: 100, y: 80 }),
        children: ['label'],
        props: { fill: '#eef2ff' },
      },
      label: { ...node('label', { x: 120, y: 100 }), componentName: 'Text' },
      other: node('other', { x: 400, y: 80 }),
    },
    components: [],
  }
}

function idFactory(prefix = 'new'): () => string {
  let seq = 0
  return () => `${prefix}-${++seq}`
}

describe('编辑命令操作', () => {
  it('复制子树包含后代并记录原父级', () => {
    const source = copySubtrees(createSchema(), ['card'])

    expect(Object.keys(source.nodes).sort()).toEqual(['card', 'label'])
    expect(source.parents.card).toBe('board')
  })

  it('插入子树时重映射 id、保留父子关系并整体偏移', () => {
    const schema = createSchema()
    const result = insertSubtrees(schema, copySubtrees(schema, ['card']), {
      offset: 20,
      createId: idFactory(),
    })

    const added = result.patches.filter((patch) => patch.op === 'add')
    expect(added).toHaveLength(2)
    expect(result.newRootIds).toEqual(['new-1'])

    const card = added.find((patch) => patch.path === '/nodes/new-1')?.value as NodeSchema
    expect(card.children).toEqual(['new-2'])
    expect(card.layout?.rect).toEqual({ x: 120, y: 100, width: 100, height: 60 })

    const parentPatch = result.patches.find((patch) => patch.path === '/nodes/board/children')
    expect(parentPatch?.value).toEqual(['card', 'new-1'])
  })

  it('删除节点会连同子树一起移除，并清理父级引用', () => {
    const patches = deleteSelection(createSchema(), ['card'])

    const removedPaths = patches
      .filter((patch) => patch.op === 'remove')
      .map((patch) => patch.path)
    expect(removedPaths.sort()).toEqual(['/nodes/card', '/nodes/label'])

    const parentPatch = patches.find((patch) => patch.path === '/nodes/board/children')
    expect(parentPatch?.value).toEqual([])
  })

  it('文档根节点不可删除', () => {
    expect(deleteSelection(createSchema(), ['board'])).toEqual([])
  })

  it('微调只平移位置', () => {
    const patches = nudgeSelection(createSchema(), ['card'], 10, -2)
    expect(patches[0]?.value).toEqual({ x: 110, y: 78, width: 100, height: 60 })
  })

  it('id 含 / 与 ~ 时路径被转义，patch 落在真正的节点上', () => {
    const schema = createSchema()
    schema.nodes['team/1'] = node('team/1', { x: 10, y: 10 })
    schema.nodes['board']!.children = ['card', 'team/1']

    const patches = nudgeSelection(schema, ['team/1'], 5, 0)
    expect(patches[0]?.path).toBe('/nodes/team~11/layout/rect')

    const next = applyPatches(schema, patches)
    expect(next.nodes['team/1']?.layout?.rect?.x).toBe(15)
    // 手写模板串会写出 /nodes/team/1，于是凭空多出名为 team 的节点
    expect(next.nodes.team).toBeUndefined()
  })
})
