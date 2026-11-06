import type { NodeSchema, PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_NODE_FLAGS,
  handleTargetIds,
  resolveNodeFlags,
  transformableIds,
} from '../src/nodes'

function node(id: string, extra: Partial<NodeSchema> = {}): NodeSchema {
  return { id, componentName: 'Box', ...extra }
}

function schema(nodes: Record<string, NodeSchema>): PageSchema {
  return { version: SCHEMA_VERSION, nodeId: 'root', nodes, components: [] }
}

describe('设计态标记推导', () => {
  it('隐藏与锁定沿子树继承', () => {
    const page = schema({
      root: node('root', { children: ['a', 'b'] }),
      a: node('a', { hidden: true, children: ['c'] }),
      b: node('b', { locked: true, children: ['d'] }),
      c: node('c'),
      d: node('d'),
    })

    const flags = resolveNodeFlags(page)
    expect([...flags.hidden]).toEqual(['a', 'c'])
    expect([...flags.locked]).toEqual(['b', 'd'])
  })

  it('未挂到根上的游离节点按自身标记判定', () => {
    const page = schema({
      root: node('root', { children: ['a'] }),
      a: node('a'),
      orphan: node('orphan', { locked: true }),
    })

    const flags = resolveNodeFlags(page)
    expect(flags.hidden.has('orphan')).toBe(false)
    expect(flags.locked.has('orphan')).toBe(true)
  })

  it('父子引用成环时不会反复遍历', () => {
    const page = schema({
      root: node('root', { children: ['a'] }),
      a: node('a', { locked: true, children: ['b'] }),
      // 反向引用父级，构造出环
      b: node('b', { children: ['a'] }),
    })

    const flags = resolveNodeFlags(page)
    expect([...flags.locked].sort()).toEqual(['a', 'b'])
  })

  it('变换过滤剔除锁定节点与文档里已不存在的 id', () => {
    const page = schema({
      root: node('root', { children: ['a', 'b'] }),
      a: node('a'),
      b: node('b', { locked: true }),
    })

    expect(transformableIds(['a', 'b', 'gone'], page)).toEqual(['a'])
  })

  it('变换过滤剔除画幅根本身', () => {
    const page = schema({
      root: node('root', { children: ['a'] }),
      a: node('a'),
    })

    // 根是画幅而不是画幅上的物件：拖动/缩放它属于改页面尺寸，不是几何变换
    expect(transformableIds(['root', 'a'], page)).toEqual(['a'])
  })

  it('标记视图暴露画幅根 id 供逐帧谓词读取', () => {
    const page = schema({
      root: node('root', { children: ['a'] }),
      a: node('a'),
    })

    expect(resolveNodeFlags(page).root).toBe('root')
    expect(EMPTY_NODE_FLAGS.root).toBeNull()
  })

  it('插槽里的子节点同样继承父级标记', () => {
    const page = schema({
      root: node('root', { slots: { header: ['a'] } }),
      a: node('a', { hidden: true }),
    })

    const flags = resolveNodeFlags(page)
    expect(flags.hidden.has('a')).toBe(true)
  })
})

describe('变换手柄目标集合', () => {
  it('画幅根与锁定节点不出手柄，其余保持选中顺序', () => {
    const page = schema({
      root: node('root', { children: ['a', 'b'] }),
      a: node('a'),
      b: node('b', { locked: true }),
    })

    const flags = resolveNodeFlags(page)
    expect(handleTargetIds(['root', 'a', 'b'], flags)).toEqual(['a'])
  })

  it('没有派生标记时按全员可变换处理', () => {
    expect(handleTargetIds(['a', 'b'], EMPTY_NODE_FLAGS)).toEqual(['a', 'b'])
  })
})
