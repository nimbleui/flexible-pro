import { describe, expect, it } from 'vitest'
import type {
  DiffResult,
  EntityChange,
  MergeConflict,
  MergeConflictKind,
  MergeLocation,
  VersionHead,
} from '@lc/contracts'
import {
  buildResolutions,
  commitAvailability,
  conflictLocation,
  conflictSeverity,
  diffCount,
  formatTime,
  formatValue,
  groupConflicts,
  groupDiff,
  historyRows,
  mergeAvailability,
  parseManualValue,
  shortHash,
  withReviewDefaults,
} from '../src/version-panel/model'

function makeConflict(
  id: string,
  kind: MergeConflictKind,
  location: Partial<MergeLocation> = {},
): MergeConflict {
  return {
    id,
    kind,
    location: {
      docId: 'page:p1',
      section: 'nodes',
      entityId: 'n1',
      fieldPath: ['x'],
      ...location,
    },
    base: 1,
    ours: 2,
    theirs: 3,
    options: ['ours', 'theirs', 'base', 'manual'],
    message: `冲突 ${id}`,
  }
}

/** 缺省是「宿主能替换工作区、在 main 上、不脏」——两个按钮都可用的那一种 head。 */
function makeHead(overrides: Partial<VersionHead> = {}): VersionHead {
  return {
    repoId: 'r',
    branch: 'main',
    commit: 'c1',
    hasUncommitted: false,
    workingTreeReplaceable: true,
    viewOnly: false,
    draftBranch: 'main',
    ...overrides,
  }
}

function makeChange(
  docId: string,
  section: string,
  entityId: string,
  change: EntityChange['change'] = 'modified',
): EntityChange {
  return { docId, section, entityId, change, base: 1, ours: 2 }
}

function makeDiff(partial: Partial<DiffResult> = {}): DiffResult {
  return {
    from: 'a',
    to: 'b',
    changes: [],
    addedDocs: [],
    removedDocs: [],
    unchangedDocs: [],
    ...partial,
  }
}

describe('冲突分级', () => {
  it('把内容取舍类冲突判为必须裁决', () => {
    expect(conflictSeverity('both-modified')).toBe('blocking')
    expect(conflictSeverity('delete-modify')).toBe('blocking')
    expect(conflictSeverity('add-add')).toBe('blocking')
  })

  it('把顺序、引用与改名意图判为建议抽查', () => {
    expect(conflictSeverity('order')).toBe('review')
    expect(conflictSeverity('dangling-ref')).toBe('review')
    expect(conflictSeverity('rename')).toBe('review')
  })

  it('分组保持内核给出的组内顺序', () => {
    const conflicts = [
      makeConflict('c1', 'order'),
      makeConflict('c2', 'both-modified'),
      makeConflict('c3', 'dangling-ref'),
      makeConflict('c4', 'delete-modify'),
    ]

    const groups = groupConflicts(conflicts)
    expect(groups.blocking.map((item) => item.id)).toEqual(['c2', 'c4'])
    expect(groups.review.map((item) => item.id)).toEqual(['c1', 'c3'])
  })
})

/**
 * 内核要求所有冲突都被裁决后才落盘，所以 review 档必须预填缺省值，
 * 否则「先接受默认再抽查」这条分级承诺兑现不了（用户会被「尚未裁决」挡住）。
 */
describe('裁决预填', () => {
  it('只给 review 档预填采用本侧，blocking 档留给用户', () => {
    const conflicts = [
      makeConflict('c1', 'order'),
      makeConflict('c2', 'both-modified'),
      makeConflict('c3', 'dangling-ref'),
      makeConflict('c4', 'delete-modify'),
      makeConflict('c5', 'rename'),
    ]

    expect(withReviewDefaults(conflicts, {})).toEqual({
      c1: 'ours',
      c3: 'ours',
      c5: 'ours',
    })
  })

  it('已有的选择不被覆盖', () => {
    const conflicts = [makeConflict('c1', 'order'), makeConflict('c2', 'rename')]

    expect(withReviewDefaults(conflicts, { c1: 'theirs' })).toEqual({
      c1: 'theirs',
      c2: 'ours',
    })
  })

  it('入参 choices 不被就地修改', () => {
    const choices: Record<string, 'ours' | 'theirs' | 'base' | 'manual'> = { c1: 'theirs' }
    withReviewDefaults([makeConflict('c2', 'order')], choices)

    expect(choices).toEqual({ c1: 'theirs' })
  })

  it('只有 review 冲突时预填即可直接落盘，不再报尚未裁决', () => {
    const conflicts = [makeConflict('c1', 'order'), makeConflict('c3', 'dangling-ref')]

    expect(buildResolutions(conflicts, { choices: {}, manual: {} }).ok).toBe(false)

    const filled = withReviewDefaults(conflicts, {})
    const result = buildResolutions(conflicts, { choices: filled, manual: {} })
    expect(result).toEqual({
      ok: true,
      resolutions: [
        { conflictId: 'c1', choice: 'ours' },
        { conflictId: 'c3', choice: 'ours' },
      ],
    })
  })

  it('blocking 冲突仍在时预填不放行', () => {
    const conflicts = [makeConflict('c1', 'order'), makeConflict('c2', 'both-modified')]
    const filled = withReviewDefaults(conflicts, {})

    const result = buildResolutions(conflicts, { choices: filled, manual: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('page:p1 / nodes / n1 / x')
  })
})

/**
 * 写动作按钮的置灰与原因。
 *
 * 内核已经会拒绝这些动作，但让用户点了才看到报错，等于把「宿主写不回工作区」这个
 * 产品限制伪装成一次操作失败。
 */
describe('写动作按钮可用性', () => {
  it('会话未就绪时两个按钮都置灰', () => {
    expect(commitAvailability(undefined)).toEqual({
      allowed: false,
      reason: '版本库会话尚未就绪',
    })
    expect(mergeAvailability(undefined)).toEqual({
      allowed: false,
      reason: '版本库会话尚未就绪',
    })
  })

  it('宿主写不回工作区时合并置灰并说明原因，提交仍可用', () => {
    const head = makeHead({ workingTreeReplaceable: false })

    expect(commitAvailability(head)).toEqual({ allowed: true, reason: '' })

    const merge = mergeAvailability(head)
    expect(merge.allowed).toBe(false)
    expect(merge.reason).toContain('写不回草稿')
  })

  it('只读查看态下提交置灰，并指名要检出回哪条分支', () => {
    const commit = commitAvailability(
      makeHead({
        workingTreeReplaceable: false,
        branch: 'feature',
        viewOnly: true,
        draftBranch: 'main',
      }),
    )

    expect(commit.allowed).toBe(false)
    expect(commit.reason).toContain('正在查看 feature')
    expect(commit.reason).toContain('检出回 main')
  })

  it('游离 HEAD 与查看态同时成立时先报游离，与内核的判定顺序一致', () => {
    const head = makeHead({ branch: undefined, draftBranch: undefined, viewOnly: true })

    expect(commitAvailability(head)).toEqual({
      allowed: false,
      reason: '游离 HEAD 需先建分支再提交',
    })
  })

  it('工作区可替换且不在查看态时两个按钮都可用', () => {
    const head = makeHead()

    expect(commitAvailability(head)).toEqual({ allowed: true, reason: '' })
    expect(mergeAvailability(head)).toEqual({ allowed: true, reason: '' })
  })

  it('脏工作区不置灰提交：那正是有待提交内容的状态', () => {
    expect(commitAvailability(makeHead({ hasUncommitted: true }))).toEqual({
      allowed: true,
      reason: '',
    })
  })
})

describe('展示格式', () => {
  it('短 hash 取前八位，空 hash 用占位符', () => {
    expect(shortHash('abcdef1234567890')).toBe('abcdef12')
    expect(shortHash('')).toBe('—')
  })

  it('非法时间原样返回，合法时间可读', () => {
    expect(formatTime('not-a-date')).toBe('not-a-date')
    expect(formatTime('2026-01-02T03:04:05.000Z')).not.toBe('2026-01-02T03:04:05.000Z')
  })

  it('undefined 与循环引用都能格式化而不抛错', () => {
    expect(formatValue(undefined)).toBe('（无）')
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(formatValue(cycle)).toContain('[object Object]')
    expect(formatValue({ x: 7 })).toBe('{\n  "x": 7\n}')
  })

  it('冲突位置拼成可读路径并跳过空段', () => {
    const conflict = makeConflict('c1', 'both-modified', { entityId: '', fieldPath: [] })
    expect(conflictLocation(conflict)).toBe('page:p1 / nodes')
  })
})

describe('手工裁决值', () => {
  it('接受合法 JSON', () => {
    expect(parseManualValue('7')).toEqual({ ok: true, value: 7 })
    expect(parseManualValue('{"x":1}')).toEqual({ ok: true, value: { x: 1 } })
  })

  it('拒绝空串与非法 JSON', () => {
    expect(parseManualValue('  ').ok).toBe(false)
    expect(parseManualValue('{').ok).toBe(false)
  })
})

describe('历史与差异分组', () => {
  it('合并提交与发布标记进入历史行', () => {
    const rows = historyRows([
      {
        id: 'a'.repeat(40),
        repoId: 'p',
        parents: ['b'.repeat(40), 'c'.repeat(40)],
        tree: { docs: {} },
        message: '合并 feature',
        author: 'alice',
        createdAt: '2026-01-02T03:04:05.000Z',
        publish: { label: 'v3', issues: [], environmentHash: 'e', publishedBy: 'alice' },
      },
    ])

    expect(rows[0].isMerge).toBe(true)
    expect(rows[0].parents).toHaveLength(2)
    expect(rows[0].publishLabel).toBe('v3')
    expect(rows[0].shortId).toBe('aaaaaaaa')
  })

  it('按文档与 section 连续切分，added / removed 落到对应文档', () => {
    const diff = makeDiff({
      changes: [
        makeChange('page:p2', 'nodes', 'n1'),
        makeChange('page:p2', 'nodes', 'n2'),
        makeChange('page:p2', 'actions', 'a1'),
        makeChange('page:p1', 'nodes', 'n1'),
      ],
      addedDocs: ['page:p1'],
      removedDocs: ['page:p3'],
    })

    const groups = groupDiff(diff)
    expect(groups.map((item) => item.docId)).toEqual(['page:p1', 'page:p2', 'page:p3'])
    expect(groups[0].added).toBe(true)
    expect(groups[1].sections.map((item) => item.section)).toEqual(['nodes', 'actions'])
    expect(groups[1].sections[0].changes).toHaveLength(2)
    expect(groups[2].removed).toBe(true)
    expect(diffCount(diff)).toBe(6)
  })
})

describe('裁决草稿', () => {
  it('全部裁决后产出与冲突一一对应的 resolutions', () => {
    const conflicts = [makeConflict('c1', 'both-modified'), makeConflict('c2', 'order')]
    const result = buildResolutions(conflicts, {
      choices: { c1: 'ours', c2: 'theirs' },
      manual: {},
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resolutions).toEqual([
        { conflictId: 'c1', choice: 'ours' },
        { conflictId: 'c2', choice: 'theirs' },
      ])
    }
  })

  it('manual 的 value 是冲突位置处的值，不额外包一层', () => {
    const result = buildResolutions([makeConflict('c1', 'both-modified')], {
      choices: { c1: 'manual' },
      manual: { c1: '7' },
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.resolutions[0].value).toBe(7)
  })

  it('任一冲突未裁决或 JSON 非法时整批拒绝', () => {
    const conflicts = [makeConflict('c1', 'both-modified'), makeConflict('c2', 'order')]

    expect(buildResolutions(conflicts, { choices: { c1: 'ours' }, manual: {} }).ok).toBe(false)
    expect(
      buildResolutions(conflicts, {
        choices: { c1: 'manual', c2: 'ours' },
        manual: { c1: '{' },
      }).ok,
    ).toBe(false)
  })

  it('拒绝文案给出可读位置，而不是把 conflictId 当 hash 截断', () => {
    // 真实 conflictId 是 `kind:docId:section:entityId:fieldPath`，不是内容地址。
    // 上面的夹具用 'c1' 当 id，截断后看起来正常，正是这个 bug 没被测出来的原因。
    const id = 'both-modified:page:p1:nodes:n1:x'
    const conflicts = [makeConflict(id, 'both-modified')]

    expect(buildResolutions(conflicts, { choices: {}, manual: {} })).toEqual({
      ok: false,
      message: '冲突「page:p1 / nodes / n1 / x」尚未裁决',
    })

    const badJson = buildResolutions(conflicts, {
      choices: { [id]: 'manual' },
      manual: { [id]: '{' },
    })
    expect(badJson.ok).toBe(false)
    if (!badJson.ok) {
      expect(badJson.message).toContain('冲突「page:p1 / nodes / n1 / x」')
      expect(badJson.message).not.toContain('both-mod')
    }
  })

  it('无冲突时给出空数组，允许干净合并继续', () => {
    expect(buildResolutions([], { choices: {}, manual: {} })).toEqual({
      ok: true,
      resolutions: [],
    })
  })
})
