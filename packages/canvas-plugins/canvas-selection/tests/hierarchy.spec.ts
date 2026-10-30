import type { NodeFlagView } from '@lc/contracts'
import type { NodeSchema } from '@lc/schema'
import type { PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import { describe, expect, it } from 'vitest'
import { nextInCycle, outermostOf, selectableParent, stackAt } from '../src/hierarchy'

function node(id: string, extra: Partial<NodeSchema> = {}): NodeSchema {
  return { id, componentName: 'Box', ...extra }
}

function page(nodes: NodeSchema[], nodeId = 'root'): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId,
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    components: [],
  }
}

function flags(partial: Partial<NodeFlagView> = {}): NodeFlagView {
  return { hidden: new Set<string>(), locked: new Set<string>(), ...partial }
}

describe('向上选择父级', () => {
  const schema = page([
    node('root', { children: ['cards'] }),
    node('cards', { children: ['cardA'] }),
    node('cardA', { children: ['label'] }),
    node('label'),
  ])

  it('返回直接父级', () => {
    expect(selectableParent(schema, 'label', flags())).toBe('cardA')
    expect(selectableParent(schema, 'cardA', flags())).toBe('cards')
  })

  it('根节点没有父级', () => {
    expect(selectableParent(schema, 'root', flags())).toBeUndefined()
  })

  it('跳过锁定的祖先，继续向上找可选中层级', () => {
    const locked = flags({ locked: new Set(['cardA']) })
    expect(selectableParent(schema, 'label', locked)).toBe('cards')
  })

  it('祖先链全部锁定或被隐藏时返回 undefined', () => {
    const blocked = flags({ locked: new Set(['cardA', 'cards', 'root']) })
    expect(selectableParent(schema, 'label', blocked)).toBeUndefined()

    const hidden = flags({ hidden: new Set(['cards']) })
    // cards 被隐藏：label 的父级 cardA 可见，仍停在 cardA
    expect(selectableParent(schema, 'label', hidden)).toBe('cardA')
    expect(selectableParent(schema, 'cardA', hidden)).toBe('root')
  })
})

describe('层叠候选与循环', () => {
  it('stackAt 把命中结果反转为自上而下', () => {
    const hitTest = { inRect: () => ['board', 'cards', 'label'] }
    expect(stackAt(hitTest, { x: 10, y: 20 })).toEqual(['label', 'cards', 'board'])
  })

  it('nextInCycle 依次向下并回到开头', () => {
    const stack = ['a', 'b', 'c']
    expect(nextInCycle(stack, 'a')).toBe('b')
    expect(nextInCycle(stack, 'c')).toBe('a')
  })

  it('当前不在候选里时从最上层开始', () => {
    expect(nextInCycle(['a', 'b'], 'elsewhere')).toBe('a')
    expect(nextInCycle(['a', 'b'], undefined)).toBe('a')
    expect(nextInCycle([], 'a')).toBeUndefined()
  })

  it('直穿到底取最底层', () => {
    expect(outermostOf(['label', 'cards', 'board'])).toBe('board')
    expect(outermostOf([])).toBeUndefined()
  })
})
