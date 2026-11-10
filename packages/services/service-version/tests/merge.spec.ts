import type { WorkingTree } from '@lc/contracts'
import { canonicalJson } from '@lc/shared'
import { describe, expect, it } from 'vitest'
import { findDanglingRefs, mergeOrderedIds, mergeTrees } from '../src/merge'

/**
 * 合并不变式属性测试的载体：规则表逐行覆盖 + 十万次随机操作序列的不变式检查。
 * 纯函数、无 store，所以随机用例可以直接跑满，不需要造对象存储。
 */

const DOC = 'page:p1'

function page(
  nodes: Record<string, unknown>,
  sections: Record<string, unknown> = {},
): WorkingTree {
  return {
    [DOC]: {
      kind: 'page',
      docSchemaVersion: '1.0.0',
      sections: { version: '1.0.0', nodes, ...sections },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nodesAt(tree: WorkingTree): Record<string, unknown> {
  const nodes = tree[DOC]?.sections.nodes
  return isRecord(nodes) ? nodes : {}
}

/** 读一个数组 section；不用类型断言，取不到就返回空数组让断言自然失败。 */
function sectionArrayAt(tree: WorkingTree, section: string): unknown[] {
  const value = tree[DOC]?.sections[section]
  return Array.isArray(value) ? value : []
}

function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

describe('有序 id 列表三方合并', () => {
  it('单侧插入按前驱锚定，两侧在不同锚点插入可交换', () => {
    const base = ['a', 'b', 'c']
    const ours = ['a', 'x', 'b', 'c']
    const theirs = ['a', 'b', 'y', 'c']

    const ab = mergeOrderedIds(base, ours, theirs)
    expect(ab.conflict).toBe(false)
    expect(ab.ids).toEqual(['a', 'x', 'b', 'y', 'c'])
    expect(mergeOrderedIds(base, theirs, ours).ids).toEqual(ab.ids)
  })

  it('两侧在同一锚点后各插新元素记 order 冲突，顺序以 ours 为先', () => {
    const result = mergeOrderedIds(['a', 'b'], ['a', 'x', 'b'], ['a', 'y', 'b'])

    expect(result.conflict).toBe(true)
    expect(result.ids).toEqual(['a', 'x', 'y', 'b'])
  })

  it('任一侧删除生效；前驱被删时记冲突但不静默丢元素', () => {
    const deleted = mergeOrderedIds(['a', 'b', 'c'], ['a', 'c'], ['a', 'b', 'c'])
    expect(deleted.ids).toEqual(['a', 'c'])
    expect(deleted.conflict).toBe(false)

    // 让新增元素 x 真正锚在被删除的前驱 a 上：ours 删 a、theirs 保留 a 并在其后插 x。
    // 若写成两侧都删 a，x 的前驱是 b（未被删），按不变式「单向改动全收」本就不该冲突。
    const orphan = mergeOrderedIds(['a', 'b'], ['b'], ['a', 'x', 'b'])
    expect(orphan.conflict).toBe(true)
    expect(new Set(orphan.ids)).toEqual(new Set(['b', 'x']))
  })

  it('同 id 两侧都移动记冲突并以 ours 为准', () => {
    const result = mergeOrderedIds(['a', 'b', 'c'], ['b', 'a', 'c'], ['a', 'c', 'b'])

    expect(result.conflict).toBe(true)
    expect(result.ids).toEqual(['b', 'a', 'c'])
  })
})

function mutateIds(ids: readonly string[], rand: () => number): string[] {
  const result = [...ids]
  const ops = 1 + Math.floor(rand() * 3)

  for (let index = 0; index < ops; index += 1) {
    const kind = Math.floor(rand() * 3)
    if (kind === 0 && result.length > 0) {
      result.splice(Math.floor(rand() * result.length), 1)
    } else if (kind === 1) {
      result.splice(Math.floor(rand() * (result.length + 1)), 0, `x${Math.floor(rand() * 8)}`)
    } else if (result.length > 1) {
      const [moved] = result.splice(Math.floor(rand() * result.length), 1)
      result.splice(Math.floor(rand() * (result.length + 1)), 0, moved)
    }
  }

  return [...new Set(result)]
}

/** 十万次随机操作序列，钉住合并的六条不变式；失败时给出前几条具体反例。 */
describe('合并不变式属性测试', () => {
  it('十万次随机序列满足可交换 / 幂等 / 单向全收 / 不消失 / 确定性', () => {
    const rand = rng(2026_1109)
    const violations: string[] = []

    const record = (label: string, detail: string): void => {
      if (violations.length < 5) violations.push(`${label}: ${detail}`)
    }

    for (let index = 0; index < 100_000; index += 1) {
      const base = ['a', 'b', 'c', 'd'].filter(() => rand() > 0.25)
      const ours = mutateIds(base, rand)
      const theirs = mutateIds(base, rand)
      const ab = mergeOrderedIds(base, ours, theirs)
      const ba = mergeOrderedIds(base, theirs, ours)
      const signature = JSON.stringify({ base, ours, theirs })

      // 幂等
      if (!sameIds(mergeOrderedIds(base, base, base).ids, base)) {
        record('幂等', signature)
      }
      // 单向改动全收
      if (!sameIds(mergeOrderedIds(base, base, theirs).ids, theirs)) {
        record('单向全收-theirs', signature)
      }
      if (!sameIds(mergeOrderedIds(base, ours, base).ids, ours)) {
        record('单向全收-ours', signature)
      }
      // 顺序确定性
      if (!sameIds(mergeOrderedIds(base, ours, theirs).ids, ab.ids)) {
        record('顺序确定性', signature)
      }
      // 结果里不允许重复 id
      if (new Set(ab.ids).size !== ab.ids.length) record('duplicate', signature)

      // 干净合并的结果不依赖谁主动合谁
      if (!ab.conflict && !ba.conflict && !sameIds(ab.ids, ba.ids)) {
        record('交换不变', signature)
      }
      // 新增实体不凭空消失（干净合并时）
      if (!ab.conflict) {
        for (const id of new Set([...ours, ...theirs])) {
          if (base.includes(id) || ab.ids.includes(id)) continue
          record('新增不消失', `${signature} 丢失 ${id}`)
          break
        }
      }
    }

    expect(violations).toEqual([])
  }, 120_000)

  it('两万次随机树满足同样的不变式', () => {
    const rand = rng(0x5eed)
    const violations: string[] = []
    const record = (label: string, detail: string): void => {
      if (violations.length < 5) violations.push(`${label}: ${detail}`)
    }

    const mutateNodes = (source: Record<string, unknown>): Record<string, unknown> => {
      const result = { ...source }
      const ops = 1 + Math.floor(rand() * 3)
      for (let index = 0; index < ops; index += 1) {
        const key = `n${Math.floor(rand() * 6)}`
        if (Math.floor(rand() * 3) === 0) delete result[key]
        else result[key] = { id: key, x: Math.floor(rand() * 3) }
      }
      return result
    }

    for (let index = 0; index < 20_000; index += 1) {
      const base = page(mutateNodes({}))
      const ours = page(mutateNodes(nodesAt(base)))
      const theirs = page(mutateNodes(nodesAt(base)))
      const ab = mergeTrees(base, ours, theirs)
      const ba = mergeTrees(base, theirs, ours)

      if (canonicalJson(mergeTrees(base, base, base).tree) !== canonicalJson(base)) {
        record('幂等', `第 ${index} 轮`)
      }
      if (canonicalJson(mergeTrees(base, base, theirs).tree) !== canonicalJson(theirs)) {
        record('单向全收-theirs', `第 ${index} 轮`)
      }
      if (canonicalJson(mergeTrees(base, ours, base).tree) !== canonicalJson(ours)) {
        record('单向全收-ours', `第 ${index} 轮`)
      }
      if (canonicalJson(mergeTrees(base, ours, theirs).tree) !== canonicalJson(ab.tree)) {
        record('顺序确定性', `第 ${index} 轮`)
      }
      if (
        ab.conflicts.length === 0 &&
        ba.conflicts.length === 0 &&
        canonicalJson(ab.tree) !== canonicalJson(ba.tree)
      ) {
        record('交换不变', `第 ${index} 轮`)
      }
      if (ab.conflicts.length === 0) {
        const resultNodes = nodesAt(ab.tree)
        const theirsNodes = nodesAt(theirs)
        for (const key of Object.keys(nodesAt(ours))) {
          if (theirsNodes[key] !== undefined && resultNodes[key] === undefined) {
            record('新增不消失', `第 ${index} 轮丢失 ${key}`)
            break
          }
        }
      }
    }

    expect(violations).toEqual([])
  }, 120_000)
})

describe('实体规则表', () => {
  it('两人各加一页与同页各改不同节点都能干净合并', () => {
    const base = page({ n1: { id: 'n1', x: 1 }, n2: { id: 'n2', x: 1 } })
    const withNewPage = (tree: WorkingTree, id: string): WorkingTree => ({
      ...tree,
      [id]: {
        kind: 'page',
        docSchemaVersion: '1.0.0',
        sections: { version: '1.0.0', nodes: { root: { id: 'root', children: [] } } },
      },
    })

    const ours = withNewPage(base, 'page:p2')
    const theirs = withNewPage(base, 'page:p3')
    const merged = mergeTrees(base, ours, theirs)

    expect(merged.conflicts).toEqual([])
    expect(Object.keys(merged.tree).sort()).toEqual(['page:p1', 'page:p2', 'page:p3'])

    const editedOurs = page({ n1: { id: 'n1', x: 2 }, n2: { id: 'n2', x: 1 } })
    const editedTheirs = page({ n1: { id: 'n1', x: 1 }, n2: { id: 'n2', x: 3 } })
    const edited = mergeTrees(base, editedOurs, editedTheirs)

    expect(edited.conflicts).toEqual([])
    expect(nodesAt(edited.tree).n1).toEqual({ id: 'n1', x: 2 })
    expect(nodesAt(edited.tree).n2).toEqual({ id: 'n2', x: 3 })
  })

  it('同一实体改不同字段自动合并，改同一字段报 both-modified', () => {
    const base = page({ n1: { id: 'n1', x: 1, y: 1 } })
    const ours = page({ n1: { id: 'n1', x: 2, y: 1 } })
    const theirs = page({ n1: { id: 'n1', x: 1, y: 2 } })

    const clean = mergeTrees(base, ours, theirs)
    expect(clean.conflicts).toEqual([])
    expect(nodesAt(clean.tree).n1).toEqual({ id: 'n1', x: 2, y: 2 })

    const conflicted = mergeTrees(base, ours, page({ n1: { id: 'n1', x: 3, y: 1 } }))
    expect(conflicted.conflicts.map((item) => item.kind)).toContain('both-modified')
  })

  it('删改冲突、同时新增同 id 与键序差异分别按规则处理', () => {
    const base = page({ n1: { id: 'n1', x: 1 } })
    const removed = page({})
    const modified = page({ n1: { id: 'n1', x: 9 } })

    const deleteModify = mergeTrees(base, removed, modified)
    expect(deleteModify.conflicts.map((item) => item.kind)).toContain('delete-modify')

    const addAdd = mergeTrees(page({}), page({ n1: { x: 1 } }), page({ n1: { x: 2 } }))
    expect(addAdd.conflicts.map((item) => item.kind)).toContain('add-add')

    const reordered = page({ n1: { x: 1, id: 'n1' } })
    expect(mergeTrees(base, reordered, base).conflicts).toEqual([])
  })

  it('裁决按 conflictId 对号入座，manual 能直接给定最终值', () => {
    const base = page({ n1: { id: 'n1', x: 1 } })
    const ours = page({ n1: { id: 'n1', x: 2 } })
    const theirs = page({ n1: { id: 'n1', x: 3 } })
    const preview = mergeTrees(base, ours, theirs)

    expect(preview.conflicts).toHaveLength(1)
    const id = preview.conflicts[0].id

    const takeTheirs = mergeTrees(base, ours, theirs, {
      resolutions: [{ conflictId: id, choice: 'theirs' }],
    })
    expect(takeTheirs.conflicts).toEqual([])
    expect(nodesAt(takeTheirs.tree).n1).toEqual({ id: 'n1', x: 3 })

    // manual 的 value 是冲突 location 处的值：冲突定位在 nodes/n1 的字段 x 上
    expect(preview.conflicts[0].location.section).toBe('nodes')
    expect(preview.conflicts[0].location.entityId).toBe('n1')
    expect(preview.conflicts[0].location.fieldPath).toEqual(['x'])
    const manual = mergeTrees(base, ours, theirs, {
      resolutions: [{ conflictId: id, choice: 'manual', value: 7 }],
    })
    expect(nodesAt(manual.tree).n1).toEqual({ id: 'n1', x: 7 })
  })
})

/**
 * 数组 section（`components` / `datasources` / `apis` / `variables` / `functions`）的顺序。
 *
 * 曾经 `mergeSection` 对键做 `.sort()` 再按 map 值序输出数组，于是两侧都改过同一个数组
 * section 时，元素被按 name / id 静默重排——违反 §6.1「数组保序，顺序就是语义」。
 */
describe('数组 section 顺序', () => {
  it('两侧各改一个元素时保持基线顺序，不按 name 重排', () => {
    const base = page(
      { n1: { id: 'n1' } },
      {
        variables: [
          { name: 'zeta', v: 1 },
          { name: 'alpha', v: 2 },
        ],
      },
    )
    const ours = page(
      { n1: { id: 'n1' } },
      {
        variables: [
          { name: 'zeta', v: 1 },
          { name: 'alpha', v: 3 },
        ],
      },
    )
    const theirs = page(
      { n1: { id: 'n1' } },
      {
        variables: [
          { name: 'zeta', v: 9 },
          { name: 'alpha', v: 2 },
        ],
      },
    )

    const result = mergeTrees(base, ours, theirs)

    expect(result.conflicts).toEqual([])
    expect(sectionArrayAt(result.tree, 'variables')).toEqual([
      { name: 'zeta', v: 9 },
      { name: 'alpha', v: 3 },
    ])
  })

  it('两侧各自新增的元素追加在基线之后，本侧先于对侧', () => {
    const base = page({ n1: { id: 'n1' } }, { variables: [{ name: 'mid', v: 0 }] })
    const ours = page(
      { n1: { id: 'n1' } },
      {
        variables: [
          { name: 'mid', v: 0 },
          { name: 'aaaOurs', v: 1 },
        ],
      },
    )
    const theirs = page(
      { n1: { id: 'n1' } },
      {
        variables: [
          { name: 'mid', v: 0 },
          { name: 'bbbTheirs', v: 2 },
        ],
      },
    )

    const result = mergeTrees(base, ours, theirs)

    expect(result.conflicts).toEqual([])
    // 按 name 排序会得到 aaaOurs / bbbTheirs / mid，正好把基线元素挤到末尾
    expect(sectionArrayAt(result.tree, 'variables')).toEqual([
      { name: 'mid', v: 0 },
      { name: 'aaaOurs', v: 1 },
      { name: 'bbbTheirs', v: 2 },
    ])
  })

  it('一侧删除元素时其余元素保持原有相对顺序', () => {
    const base = page(
      { n1: { id: 'n1' } },
      {
        variables: [
          { name: 'a', v: 1 },
          { name: 'b', v: 2 },
          { name: 'c', v: 3 },
        ],
      },
    )
    const ours = page(
      { n1: { id: 'n1' } },
      {
        variables: [
          { name: 'a', v: 1 },
          { name: 'c', v: 3 },
        ],
      },
    )
    const theirs = page(
      { n1: { id: 'n1' } },
      {
        variables: [
          { name: 'a', v: 9 },
          { name: 'b', v: 2 },
          { name: 'c', v: 3 },
        ],
      },
    )

    const result = mergeTrees(base, ours, theirs)

    expect(sectionArrayAt(result.tree, 'variables')).toEqual([
      { name: 'a', v: 9 },
      { name: 'c', v: 3 },
    ])
  })

  it('字典 section 按排序键遍历，冲突顺序与工作区的键插入序无关', () => {
    // 插入顺序刻意与字典序相反：section 存进对象库再读回来时 canonicalJson 已经排过序，
    // 而直接来自宿主工作区的树没有，两者必须得到同一份冲突清单
    const base = page({ n2: { id: 'n2', x: 0 }, n1: { id: 'n1', x: 0 } })
    const ours = page({ n1: { id: 'n1', x: 1 }, n2: { id: 'n2', x: 1 } })
    const theirs = page({ n2: { id: 'n2', x: 2 }, n1: { id: 'n1', x: 2 } })

    const result = mergeTrees(base, ours, theirs)

    expect(result.conflicts.map((item) => item.location.entityId)).toEqual(['n1', 'n2'])
  })
})

describe('悬空引用与改名意图', () => {
  it('一侧删节点、另一侧引用它时报告 dangling-ref', () => {
    const base = page({ n1: { id: 'n1', children: [] }, n2: { id: 'n2' } })
    const ours = page({ n1: { id: 'n1', children: [] } })
    const theirs = page({
      n1: { id: 'n1', children: ['n2'] },
      n2: { id: 'n2' },
    })

    const result = mergeTrees(base, ours, theirs)

    expect(result.danglingRefs.map((item) => item.refId)).toContain('n2')
    expect(result.conflicts.map((item) => item.kind)).toContain('dangling-ref')

    const refConflict = result.conflicts.find((item) => item.kind === 'dangling-ref')
    expect(refConflict).toBeDefined()
    const resolved = mergeTrees(base, ours, theirs, {
      resolutions: [{ conflictId: refConflict?.id ?? '', choice: 'manual', value: [] }],
    })
    expect(nodesAt(resolved.tree).n1).toEqual({ id: 'n1', children: [] })
    expect(resolved.conflicts.some((item) => item.kind === 'dangling-ref')).toBe(false)
  })

  it('actionIds / flowId 的跨表引用也纳入集中规则表', () => {
    const tree = page(
      { n1: { id: 'n1' } },
      {
        connections: { c1: { id: 'c1', actionIds: ['missing-action'] } },
        actions: { a1: { id: 'a1' } },
      },
    )
    expect(findDanglingRefs(tree).map((item) => item.refId)).toContain('missing-action')

    const flow = {
      'flow:f1': {
        kind: 'flow' as const,
        docSchemaVersion: '1.0.0',
        sections: { nodes: { n1: { id: 'n1', flowId: 'gone' } } },
      },
    }
    const refs = findDanglingRefs(flow, new Set(['flow:f1', 'flow:gone']))
    expect(refs).toHaveLength(0)
    expect(findDanglingRefs(flow, new Set(['flow:f1'])).map((item) => item.refId)).toContain(
      'gone',
    )
  })

  it('数组 section 里的跨文档引用同样受检（apis[].apiId）', () => {
    const tree = page(
      { n1: { id: 'n1' } },
      {
        apis: [
          { id: 'user', apiId: 'gone' },
          { id: 'order', apiId: 'kept' },
        ],
      },
    )

    const refs = findDanglingRefs(tree, new Set([DOC, 'api:kept']))

    expect(refs.map((item) => item.refId)).toEqual(['gone'])
    expect(refs[0]?.location).toMatchObject({
      docId: DOC,
      section: 'apis',
      entityId: 'user',
      fieldPath: ['apiId'],
    })
  })

  it('数组 section 的悬空引用产生冲突，manual 裁决写回数组元素', () => {
    const apiDoc = {
      'api:kept': {
        kind: 'api' as const,
        docSchemaVersion: '1.0.0',
        sections: { meta: { id: 'kept' } },
      },
    }
    const base: WorkingTree = {
      ...page({ n1: { id: 'n1' } }, { apis: [{ id: 'user', apiId: 'kept' }] }),
      ...apiDoc,
    }
    const ours: WorkingTree = {
      ...page(
        { n1: { id: 'n1' } },
        {
          apis: [
            { id: 'user', apiId: 'kept' },
            { id: 'extra', apiId: 'kept' },
          ],
        },
      ),
      ...apiDoc,
    }
    const theirs: WorkingTree = {
      ...page({ n1: { id: 'n1' } }, { apis: [{ id: 'user', apiId: 'gone' }] }),
      ...apiDoc,
    }

    const result = mergeTrees(base, ours, theirs)
    expect(result.danglingRefs.map((item) => item.refId)).toContain('gone')

    const conflict = result.conflicts.find((item) => item.kind === 'dangling-ref')
    expect(conflict?.location).toMatchObject({
      docId: DOC,
      section: 'apis',
      entityId: 'user',
      fieldPath: ['apiId'],
    })

    const resolved = mergeTrees(base, ours, theirs, {
      resolutions: [{ conflictId: conflict?.id ?? '', choice: 'manual', value: 'kept' }],
    })
    const apis = resolved.tree[DOC]?.sections.apis
    expect(Array.isArray(apis)).toBe(true)
    const bindings: unknown[] = Array.isArray(apis) ? apis : []
    expect(bindings.map((item) => (isRecord(item) ? item.apiId : undefined))).toEqual([
      'kept',
      'kept',
    ])
    expect(resolved.conflicts.some((item) => item.kind === 'dangling-ref')).toBe(false)
  })

  it('一侧改名、另一侧没动旧 id 时自动迁移并重写引用', () => {
    const base = page({ n1: { id: 'n1', children: [] }, n2: { id: 'n2', children: ['n1'] } })
    const ours = page({ n9: { id: 'n9', children: [] }, n2: { id: 'n2', children: ['n9'] } })
    const theirs = page({ n1: { id: 'n1', children: [] }, n2: { id: 'n2', children: ['n1'] } })

    const result = mergeTrees(base, ours, theirs, {
      oursIntents: [{ from: 'n1', to: 'n9', docId: DOC, section: 'nodes' }],
    })

    expect(result.appliedIntents).toHaveLength(1)
    expect(result.conflicts).toEqual([])
    expect(nodesAt(result.tree).n1).toBeUndefined()
    expect(nodesAt(result.tree).n9).toBeDefined()
    expect(nodesAt(result.tree).n2).toEqual({ id: 'n2', children: ['n9'] })
  })
})
