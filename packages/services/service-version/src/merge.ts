import type {
  CommitIntent,
  DanglingRef,
  MergeConflict,
  MergeConflictKind,
  MergeLocation,
  MergeResolution,
  VersionDocKind,
  VersionDocument,
  WorkingTree,
} from '@lc/contracts'
import { canonicalJson } from '@lc/shared'
import { entityMapOf } from './diff'
import { DEFAULT_DOC_SCHEMA_VERSION } from './projection'

/**
 * 三方合并内核：纯函数，不碰 store / DOM / Vue。
 *
 * 输入输出都是 `WorkingTree`，所以属性测试可以直接跑十万次随机用例，不需要造对象存储。
 * 唯一的可变状态是 `MergeContext.conflicts`；所有中间树都是新对象或引用共享，不改入参。
 *
 * 合并规则表实现为「section → 实体 → 字段」三层受控递归：
 * - section 快路径：两侧一致 / 一侧与基线一致时整篇跳过；
 * - 实体层：按稳定 id 取三方并集，套增删改规则表；
 * - 字段层：同实体不同字段可自动合并，同字段两侧不同改动仍报 `both-modified`。
 *   这比把实体当整块比较更贴合低代码的实际编辑形状，且不会丢任一侧内容。
 *
 * 有序 id 列表与悬空引用的规则都集中在下面的常量表里，
 * 新增一类引用只改表，不散到递归里。
 */

/** 缺失哨兵：数据里的 `undefined` 与「这一侧没有这个键」是两回事，不能混用。 */
const MISSING: unique symbol = Symbol('merge.missing')

function isMissing(value: unknown): value is typeof MISSING {
  return value === MISSING
}

function cell(value: unknown): unknown {
  return isMissing(value) ? undefined : value
}

function equal(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 这些字段的值按有序 id 列表处理，走前驱锚定而不是稳定键字典。 */
const ORDERED_ID_FIELDS: ReadonlySet<string> = new Set([
  'children',
  'actionIds',
  'nodeIds',
  'sequence',
  'order',
  'slotIds',
])

function isOrderedIdField(field: string, path: readonly string[]): boolean {
  return ORDERED_ID_FIELDS.has(field) || path.some((part) => part === 'slots')
}

function isIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 引用规则表：`section` 为 `*` 表示任意 section。 */
type RefTarget = 'nodes' | 'actions' | 'flows' | 'apis' | 'pages'

/** 引用完整性规则：某 section 的某字段指向哪类实体；`section` 为 `*` 表示任意 section。 */
interface RefRule {
  /** 适用 section 名；`*` 通配 */
  section: string
  /** 适用字段名 */
  field: string
  /** 引用指向的实体类别 */
  target: RefTarget
}

const REFERENCE_RULES: readonly RefRule[] = [
  { section: 'nodes', field: 'children', target: 'nodes' },
  { section: 'nodes', field: 'slots', target: 'nodes' },
  { section: 'nodes', field: 'parentId', target: 'nodes' },
  { section: 'connections', field: 'actionIds', target: 'actions' },
  { section: 'connections', field: 'nodeId', target: 'nodes' },
  { section: 'edges', field: 'source', target: 'nodes' },
  { section: 'edges', field: 'target', target: 'nodes' },
  { section: '*', field: 'flowId', target: 'flows' },
  { section: '*', field: 'apiId', target: 'apis' },
  { section: '*', field: 'pageId', target: 'pages' },
]

/** 改名时要重写的标量引用字段；数组里的 id 由 `isOrderedIdField` 覆盖。 */
const ID_SCALAR_FIELDS: ReadonlySet<string> = new Set([
  // 实体自身也带 id 字段；改名时只改字典键不改它会让两侧同一实体看起来不同
  'id',
  'nodeId',
  'parentId',
  'source',
  'target',
  'flowId',
  'apiId',
  'pageId',
  'actionId',
])

/* ── 有序 id 列表 ───────────────────────────────────────────────────── */

/** 有序 id 列表三方合并的结果。 */
export interface MergeOrderedResult {
  /** 合并后的有序 id 列表 */
  ids: string[]
  /** 两侧在同一锚点后插入、同 id 两侧都移动、或前驱被删 */
  conflict: boolean
}

/**
 * 三个 id 序列的三方合并。
 *
 * 规则：任一侧删除生效；新 id 按「在基线里存在的前驱」插入；前驱被删记冲突；
 * 同 id 两侧都移动以 ours 为准并记冲突；两侧在同一锚点后各插新元素记 `order` 冲突
 * （因此**干净合并**不含这种情形，结果对 ours/theirs 交换不变）。
 */
export function mergeOrderedIds(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): MergeOrderedResult {
  if (equal(ours, theirs)) return { ids: [...ours], conflict: false }
  if (equal(ours, base)) return { ids: [...theirs], conflict: false }
  if (equal(theirs, base)) return { ids: [...ours], conflict: false }

  const baseSet = new Set(base)
  const oursSet = new Set(ours)
  const theirsSet = new Set(theirs)
  const newInOurs = new Set(ours.filter((id) => !baseSet.has(id)))
  const newInTheirs = new Set(theirs.filter((id) => !baseSet.has(id)))

  const removed = new Set<string>()
  for (const id of base) {
    if (!oursSet.has(id) || !theirsSet.has(id)) removed.add(id)
  }

  /** 每个 id 的前驱取「左侧最近的基线 id」，跳过新增元素。 */
  const predOf = (ids: readonly string[]): Map<string, string> => {
    const map = new Map<string, string>()
    let anchor = ''
    for (const id of ids) {
      map.set(id, anchor)
      if (baseSet.has(id)) anchor = id
    }
    return map
  }

  const basePred = predOf(base)
  const ourPred = predOf(ours)
  const theirPred = predOf(theirs)
  const present = new Set<string>([
    ...ours.filter((id) => !removed.has(id)),
    ...theirs.filter((id) => !removed.has(id)),
  ])

  let conflict = false
  const pred = new Map<string, string>()
  const anchors = new Map<string, { ours: number; theirs: number }>()

  for (const id of present) {
    const b = basePred.get(id) ?? ''
    const o = ourPred.get(id) ?? b
    const t = theirPred.get(id) ?? b
    let chosen = b

    if (o !== b && t !== b) {
      if (o !== t) conflict = true
      chosen = o
    } else if (o !== b) {
      chosen = o
    } else if (t !== b) {
      chosen = t
    }

    if (removed.has(chosen)) {
      conflict = true
      chosen = basePred.get(chosen) ?? ''
    }

    pred.set(id, chosen)
    const bucket = anchors.get(chosen) ?? { ours: 0, theirs: 0 }
    if (newInOurs.has(id)) bucket.ours += 1
    if (newInTheirs.has(id)) bucket.theirs += 1
    anchors.set(chosen, bucket)
  }

  for (const bucket of anchors.values()) {
    if (bucket.ours > 0 && bucket.theirs > 0) conflict = true
  }

  // 同一锚点下「新插入的元素」必须排在基线的原后继之前，否则前驱锚定会把新元素
  // 挤到整段尾部。ours 新增 → theirs 新增 → 基线元素，同一 id 只出现一次。
  const order: string[] = []
  const seen = new Set<string>()
  for (const id of [
    ...ours.filter((item) => present.has(item) && !baseSet.has(item)),
    ...theirs.filter((item) => present.has(item) && !baseSet.has(item) && !oursSet.has(item)),
    ...base.filter((item) => present.has(item)),
  ]) {
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }
  const rank = new Map(order.map((id, index) => [id, index] as const))

  const children = new Map<string, string[]>()
  for (const id of order) {
    const anchor = pred.get(id) ?? ''
    const list = children.get(anchor) ?? []
    list.push(id)
    children.set(anchor, list)
  }
  for (const list of children.values()) {
    list.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
  }

  const ids: string[] = []
  const visited = new Set<string>()
  const visit = (anchor: string): void => {
    for (const id of children.get(anchor) ?? []) {
      if (visited.has(id)) continue
      visited.add(id)
      ids.push(id)
      visit(id)
    }
  }
  visit('')

  // 前驱成环时挂到末尾，不静默丢实体
  for (const id of order) {
    if (visited.has(id)) continue
    conflict = true
    visited.add(id)
    ids.push(id)
  }

  return { ids, conflict }
}

/* ── 三方值合并 ─────────────────────────────────────────────── */

/** 一次合并计算的运行期上下文：已收集的冲突、裁决与偏好侧。 */
interface MergeContext {
  /** 已检测到的冲突清单 */
  conflicts: MergeConflict[]
  /** 冲突 id → 人工裁决 */
  resolutions: Map<string, MergeResolution>
  /** 冲突位暂取哪一侧 */
  prefer: 'ours' | 'theirs'
}

/** 合并三棵工作树的选项；`resolutions` 来自人工裁决，`knownDocs` 用于悬空引用判定。 */
export interface MergeTreeOptions {
  /** 已应用的裁决；缺项表示沿用默认（自动合并可解的部分） */
  resolutions?: readonly MergeResolution[]
  /** 冲突位暂取哪一侧；虚拟基线用 `theirs` 时可传 @default 'ours' */
  prefer?: 'ours' | 'theirs'
  /** 当前侧已应用的改名意图，合并时回放以保持覆盖顺序 */
  oursIntents?: readonly CommitIntent[]
  /** 被合入侧已应用的改名意图 */
  theirsIntents?: readonly CommitIntent[]
  /** 三方树里出现过的文档 id 并集，用于判定「引用指向另一侧删掉的文档」 */
  knownDocs?: ReadonlySet<string>
}

/** 合并三棵工作树的结果：最终树、冲突清单、悬空引用与已应用的改名意图。 */
export interface MergeTreeResult {
  /** 最终合并出的工作树 */
  tree: WorkingTree
  /** 合并不了的冲突清单，需人工裁决 */
  conflicts: MergeConflict[]
  /** 指向已删除实体的悬空引用 */
  danglingRefs: DanglingRef[]
  /** 已自动应用的改名意图，供 UI 说明另一侧插入落点 */
  appliedIntents: CommitIntent[]
}

function conflictId(loc: MergeLocation, kind: MergeConflictKind): string {
  return `${kind}:${loc.docId}:${loc.section}:${loc.entityId}:${loc.fieldPath.join('/')}`
}

function optionsFor(kind: MergeConflictKind): Array<MergeResolution['choice']> {
  switch (kind) {
    case 'add-add':
    case 'order':
    case 'rename':
    case 'dangling-ref':
      return ['ours', 'theirs', 'manual']
    default:
      return ['ours', 'theirs', 'base', 'manual']
  }
}

function decide(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  loc: MergeLocation,
  kind: MergeConflictKind,
  ctx: MergeContext,
): unknown {
  const id = conflictId(loc, kind)
  const resolution = ctx.resolutions.get(id)

  if (resolution) {
    switch (resolution.choice) {
      case 'ours':
        return ours
      case 'theirs':
        return theirs
      case 'base':
        return base
      case 'manual':
        return resolution.value === undefined ? MISSING : resolution.value
    }
  }

  ctx.conflicts.push({
    id,
    kind,
    location: loc,
    base: cell(base),
    ours: cell(ours),
    theirs: cell(theirs),
    options: optionsFor(kind),
    message: `「${loc.docId}/${loc.section || '文档'}${loc.entityId ? `/${loc.entityId}` : ''}」三方改动冲突（${kind}）`,
  })

  return ctx.prefer === 'theirs' ? theirs : ours
}

function mergeValue(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  loc: MergeLocation,
  ctx: MergeContext,
): unknown {
  const bMissing = isMissing(base)
  const oMissing = isMissing(ours)
  const tMissing = isMissing(theirs)

  if (oMissing && tMissing) return MISSING
  // 「两侧一致」必须先于 add-add：两侧新增同一种文档时 kind / version 完全相同，
  // 不能因为基线缺失就判成冲突。equal() 不能吃 MISSING 哨兵，所以逐条加守卫。
  if (!oMissing && !tMissing && equal(ours, theirs)) return ours
  if (!bMissing && !oMissing && equal(base, ours)) return tMissing ? MISSING : theirs
  if (!bMissing && !tMissing && equal(base, theirs)) return oMissing ? MISSING : ours

  if (oMissing || tMissing) {
    if (bMissing) return oMissing ? theirs : ours
    const kept = oMissing ? theirs : ours
    if (equal(base, kept)) return MISSING
    return decide(base, ours, theirs, loc, 'delete-modify', ctx)
  }
  if (bMissing) return decide(base, ours, theirs, loc, 'add-add', ctx)

  if (isIdArray(base) && isIdArray(ours) && isIdArray(theirs)) {
    const field = loc.fieldPath[loc.fieldPath.length - 1] ?? loc.section
    if (isOrderedIdField(field, loc.fieldPath)) {
      const merged = mergeOrderedIds(base, ours, theirs)
      if (merged.conflict) {
        ctx.conflicts.push({
          id: conflictId(loc, 'order'),
          kind: 'order',
          location: loc,
          base,
          ours,
          theirs,
          options: optionsFor('order'),
          message: `「${loc.docId}/${loc.section}」有序列表两侧插入/移动冲突`,
        })
      }
      return merged.ids
    }
  }

  if (isRecord(base) && isRecord(ours) && isRecord(theirs)) {
    const keys = [
      ...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]),
    ].sort()
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      const childLoc: MergeLocation = { ...loc, fieldPath: [...loc.fieldPath, key] }
      const value = mergeValue(
        Object.prototype.hasOwnProperty.call(base, key) ? base[key] : MISSING,
        Object.prototype.hasOwnProperty.call(ours, key) ? ours[key] : MISSING,
        Object.prototype.hasOwnProperty.call(theirs, key) ? theirs[key] : MISSING,
        childLoc,
        ctx,
      )
      if (!isMissing(value)) result[key] = value
    }
    return result
  }

  if (Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) {
    return mergeArray(base, ours, theirs, loc, ctx)
  }

  return decide(base, ours, theirs, loc, 'both-modified', ctx)
}

/**
 * 三方实体 map 的键序：基线序 → 本侧新增 → 对侧新增。
 *
 * 这条规则由数组 section 与嵌套数组共用，所以抽出来：数组的顺序就是语义（§6.1），
 * 而 `mergeSection` 与 `mergeArray` 曾经各写一份，前者多了一个 `.sort()`，结果
 * `variables` / `functions` / `datasources` / `components` / `apis` 在一次两侧都改过的
 * 合并后被按 name / id 静默重排。字典调用方可以在拿到结果后自行排序（键序无语义，
 * `canonicalJson` 会排序），数组调用方必须原样使用。
 */
function mergedKeys(
  base: ReadonlyMap<string, unknown>,
  ours: ReadonlyMap<string, unknown>,
  theirs: ReadonlyMap<string, unknown>,
): string[] {
  const oursOnly = [...ours.keys()].filter((key) => !base.has(key))
  const theirsOnly = [...theirs.keys()].filter((key) => !base.has(key) && !ours.has(key))

  return [...new Set([...base.keys(), ...oursOnly, ...theirsOnly])]
}

function mergeArray(
  base: readonly unknown[],
  ours: readonly unknown[],
  theirs: readonly unknown[],
  loc: MergeLocation,
  ctx: MergeContext,
): unknown[] {
  const bm = entityMapOf(loc.section, base)
  const om = entityMapOf(loc.section, ours)
  const tm = entityMapOf(loc.section, theirs)
  const keys = mergedKeys(bm, om, tm)

  const result: unknown[] = []
  for (const key of keys) {
    const childLoc: MergeLocation = { ...loc, entityId: key, fieldPath: [] }
    const value = mergeValue(
      bm.has(key) ? bm.get(key) : MISSING,
      om.has(key) ? om.get(key) : MISSING,
      tm.has(key) ? tm.get(key) : MISSING,
      childLoc,
      ctx,
    )
    if (!isMissing(value)) result.push(value)
  }

  return result
}

/* ── 改名意图 ──────────────────────────────────────────────────────── */

function renameReferences(
  value: unknown,
  from: string,
  to: string,
  field: string,
  path: readonly string[],
): unknown {
  if (typeof value === 'string') {
    const isId = ID_SCALAR_FIELDS.has(field) || isOrderedIdField(field, path)
    return value === from && isId ? to : value
  }
  if (Array.isArray(value)) {
    return value.map((item) => renameReferences(item, from, to, field, [...path, field]))
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = renameReferences(item, from, to, key, [...path, key])
    }
    return result
  }
  return value
}

function renameInTree(
  tree: WorkingTree,
  intent: CommitIntent,
): 'applied' | 'conflict' | 'noop' {
  const doc = tree[intent.docId]
  if (!doc) return 'noop'
  const section = doc.sections[intent.section]
  if (!isRecord(section) || !(intent.from in section)) return 'noop'
  if (intent.to in section) return 'conflict'

  section[intent.to] = section[intent.from]
  delete section[intent.from]
  for (const [key, value] of Object.entries(doc.sections)) {
    doc.sections[key] = renameReferences(value, intent.from, intent.to, key, [])
  }

  return 'applied'
}

/* ── 悬空引用 ──────────────────────────────────────────────────────── */

function collectRefs(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRefs(item))
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((item) => collectRefs(item))
  }
  return []
}

function keysOf(value: unknown): Set<string> {
  return isRecord(value) ? new Set(Object.keys(value)) : new Set()
}

/**
 * 找出指向已不存在实体的引用。
 *
 * `knownDocs` 是三方树的文档 id 并集：只看合并结果会漏掉「另一侧删掉的文档」，
 * 只看结果会让「三方都没有 api 文档」的普通页面全部误报，两头都要顾到。
 */
export function findDanglingRefs(
  tree: WorkingTree,
  knownDocs: ReadonlySet<string> = new Set(Object.keys(tree)),
): DanglingRef[] {
  const result: DanglingRef[] = []
  const allDocs = [...knownDocs]
  const hasFlowDocs = allDocs.some((id) => id.startsWith('flow:'))
  const hasApiDocs = allDocs.some((id) => id.startsWith('api:'))
  const hasPageDocs = allDocs.some((id) => id.startsWith('page:'))

  for (const [docId, doc] of Object.entries(tree)) {
    const nodes = keysOf(doc.sections.nodes)
    const actions = keysOf(doc.sections.actions)

    for (const [section, value] of Object.entries(doc.sections)) {
      // 数组 section（components / datasources / apis / variables / functions）同样带引用
      // 字段，只扫字典会漏掉 `apis[].apiId` 这类跨文档引用。entityMapOf 已按稳定键摊平
      // 数组，entityId 与 diff 口径一致，裁决才能定位回原处。
      for (const [entityId, entity] of entityMapOf(section, value)) {
        if (!isRecord(entity)) continue

        for (const rule of REFERENCE_RULES) {
          if (rule.section !== '*' && rule.section !== section) continue
          const fieldValue = entity[rule.field]
          if (fieldValue === undefined) continue

          for (const refId of collectRefs(fieldValue)) {
            let exists: boolean
            switch (rule.target) {
              case 'nodes':
                exists = nodes.size === 0 || nodes.has(refId)
                break
              case 'actions':
                exists = actions.size === 0 || actions.has(refId)
                break
              case 'flows':
                exists = !hasFlowDocs || knownDocs.has(refId) || knownDocs.has(`flow:${refId}`)
                break
              case 'apis':
                exists = !hasApiDocs || knownDocs.has(refId) || knownDocs.has(`api:${refId}`)
                break
              case 'pages':
                exists = !hasPageDocs || knownDocs.has(refId) || knownDocs.has(`page:${refId}`)
                break
            }
            if (exists) continue

            result.push({
              location: { docId, section, entityId, fieldPath: [rule.field] },
              field: rule.field,
              refId,
            })
          }
        }
      }
    }
  }

  return result
}

/* ── 树的读写定位 ───────────────────────────────────────────────────────── */

/**
 * 按 `entityId` 取出 section 里的一个实体。
 *
 * 字典 section 直接用键；数组 section 的键来自 `entityMapOf` 的稳定键（id / name / …），
 * 必须先换回下标——否则数组里的悬空引用能被检出，裁决却读不到也写不回原处。
 */
function entityAt(section: unknown, loc: MergeLocation): unknown {
  if (section === undefined) return MISSING
  if (loc.entityId === '') return section

  if (isRecord(section)) {
    const value = section[loc.entityId]
    return value === undefined ? MISSING : value
  }

  if (Array.isArray(section)) {
    const index = [...entityMapOf(loc.section, section).keys()].indexOf(loc.entityId)
    return index < 0 ? MISSING : section[index]
  }

  return MISSING
}

/** 读取定位处的值；路径缺失或值为 undefined 时返回未导出的内部缺失哨兵，供包内冲突裁决使用。 */
export function valueAt(tree: WorkingTree, loc: MergeLocation): unknown {
  const doc = tree[loc.docId]
  if (!doc) return MISSING

  let node: unknown = entityAt(doc.sections[loc.section], loc)
  for (const field of loc.fieldPath) {
    if (Array.isArray(node) || !isRecord(node)) return MISSING
    node = node[field]
  }

  return node === undefined ? MISSING : node
}

function setValueAt(tree: WorkingTree, loc: MergeLocation, value: unknown): void {
  const doc = tree[loc.docId]
  if (!doc) return

  const field = loc.fieldPath[loc.fieldPath.length - 1]
  if (field === undefined) return

  let node: unknown = entityAt(doc.sections[loc.section], loc)
  for (const part of loc.fieldPath.slice(0, -1)) {
    if (Array.isArray(node) || !isRecord(node)) return
    node = node[part]
  }
  if (isRecord(node)) node[field] = value
}

function resolvedValue(
  resolution: MergeResolution,
  trees: readonly WorkingTree[],
  loc: MergeLocation,
  prefer: 'ours' | 'theirs',
): unknown {
  switch (resolution.choice) {
    case 'ours':
      return valueAt(trees[1], loc)
    case 'theirs':
      return valueAt(trees[2], loc)
    case 'base':
      return valueAt(trees[0], loc)
    case 'manual':
      return resolution.value === undefined ? MISSING : resolution.value
  }
}

/* ── 主入口 ─────────────────────────────────────────────────────────────── */

function sectionShape(value: unknown): 'array' | 'record' | 'scalar' {
  if (Array.isArray(value)) return 'array'
  if (isRecord(value)) return 'record'
  return 'scalar'
}

function sectionMapOf(value: unknown): Map<string, unknown> {
  if (isMissing(value)) return new Map()
  if (Array.isArray(value)) return entityMapOf('', value)
  if (isRecord(value)) {
    const map = new Map<string, unknown>()
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) map.set(key, item)
    }
    return map
  }
  return new Map([['', value]])
}

function asVersionDocument(value: unknown): VersionDocument | undefined {
  if (!isRecord(value) || !isDocKind(value.kind) || !isRecord(value.sections)) return undefined
  return {
    kind: value.kind,
    docSchemaVersion:
      typeof value.docSchemaVersion === 'string'
        ? value.docSchemaVersion
        : DEFAULT_DOC_SCHEMA_VERSION,
    sections: value.sections,
  }
}

function isDocKind(value: unknown): value is VersionDocKind {
  return (
    value === 'page' ||
    value === 'flow' ||
    value === 'function' ||
    value === 'component' ||
    value === 'api'
  )
}

function mergeSection(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  loc: MergeLocation,
  ctx: MergeContext,
): unknown {
  const bMissing = isMissing(base)
  const oMissing = isMissing(ours)
  const tMissing = isMissing(theirs)

  // 整节级别的快路径必须在展开成实体 map 之前：否则「删掉整节」会变成空字典，
  // 结果里凭空多出一个 section，破坏「另一侧没改就全收那一侧」。
  if (oMissing && tMissing) return MISSING
  if (!oMissing && !tMissing && equal(ours, theirs)) return ours
  if (!bMissing && !oMissing && equal(base, ours)) return tMissing ? MISSING : theirs
  if (!bMissing && !tMissing && equal(base, theirs)) return oMissing ? MISSING : ours
  if (oMissing || tMissing) return mergeValue(base, ours, theirs, loc, ctx)

  if (
    isIdArray(base) &&
    isIdArray(ours) &&
    isIdArray(theirs) &&
    isOrderedIdField(loc.section, [])
  ) {
    return mergeValue(base, ours, theirs, loc, ctx)
  }

  const shapeSource = !bMissing ? base : ours
  const shape = sectionShape(shapeSource)
  const bm = sectionMapOf(base)
  const om = sectionMapOf(ours)
  const tm = sectionMapOf(theirs)
  const merged = mergedKeys(bm, om, tm)
  // 数组必须保持基线序：顺序就是语义（§6.1）。字典的键序无语义（canonicalJson 会排序），
  // 排一下只为让冲突清单的顺序不随 ours / theirs 交换而变。
  const keys = shape === 'array' ? merged : [...merged].sort()
  const map = new Map<string, unknown>()

  for (const key of keys) {
    const childLoc: MergeLocation = { ...loc, entityId: key, fieldPath: [] }
    const value = mergeValue(
      bm.has(key) ? bm.get(key) : MISSING,
      om.has(key) ? om.get(key) : MISSING,
      tm.has(key) ? tm.get(key) : MISSING,
      childLoc,
      ctx,
    )
    if (!isMissing(value)) map.set(key, value)
  }

  if (shape === 'array') return [...map.values()]
  if (shape === 'record') return Object.fromEntries(map)
  return map.has('') ? map.get('') : MISSING
}

function mergeDoc(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  docId: string,
  ctx: MergeContext,
): VersionDocument | undefined {
  const bDoc = asVersionDocument(base)
  const oDoc = asVersionDocument(ours)
  const tDoc = asVersionDocument(theirs)
  const loc: MergeLocation = { docId, section: '', entityId: '', fieldPath: [] }

  const kind = mergeValue(
    bDoc?.kind ?? MISSING,
    oDoc?.kind ?? MISSING,
    tDoc?.kind ?? MISSING,
    {
      ...loc,
      fieldPath: ['kind'],
    },
    ctx,
  )
  const version = mergeValue(
    bDoc?.docSchemaVersion ?? MISSING,
    oDoc?.docSchemaVersion ?? MISSING,
    tDoc?.docSchemaVersion ?? MISSING,
    { ...loc, fieldPath: ['docSchemaVersion'] },
    ctx,
  )

  const sectionNames = [
    ...new Set([
      ...Object.keys(bDoc?.sections ?? {}),
      ...Object.keys(oDoc?.sections ?? {}),
      ...Object.keys(tDoc?.sections ?? {}),
    ]),
  ].sort()
  const sections: Record<string, unknown> = {}

  for (const section of sectionNames) {
    const sectionLoc: MergeLocation = { docId, section, entityId: '', fieldPath: [] }
    const value = mergeSection(
      bDoc?.sections[section] === undefined ? MISSING : bDoc.sections[section],
      oDoc?.sections[section] === undefined ? MISSING : oDoc.sections[section],
      tDoc?.sections[section] === undefined ? MISSING : tDoc.sections[section],
      sectionLoc,
      ctx,
    )
    if (!isMissing(value)) sections[section] = value
  }

  if (isMissing(kind) || !isDocKind(kind)) return undefined
  return {
    kind,
    docSchemaVersion: typeof version === 'string' ? version : DEFAULT_DOC_SCHEMA_VERSION,
    sections,
  }
}

/**
 * 合并三棵工作树。
 *
 * 不写任何对象、不移动任何 ref；`mergePreview` / `merge` / 虚拟基线折叠都调用它，
 * 保证「预览看到的」与「落盘的」是同一套计算结果。
 */
export function mergeTrees(
  base: WorkingTree,
  ours: WorkingTree,
  theirs: WorkingTree,
  options: MergeTreeOptions = {},
): MergeTreeResult {
  const ctx: MergeContext = {
    conflicts: [],
    resolutions: new Map((options.resolutions ?? []).map((item) => [item.conflictId, item])),
    prefer: options.prefer ?? 'ours',
  }

  const normalizedOurs = structuredClone(ours)
  const normalizedTheirs = structuredClone(theirs)
  const appliedIntents: CommitIntent[] = []

  for (const intent of options.oursIntents ?? []) {
    const outcome = renameInTree(normalizedTheirs, intent)
    if (outcome === 'applied') appliedIntents.push(intent)
    if (outcome === 'conflict') {
      const loc: MergeLocation = {
        docId: intent.docId,
        section: intent.section,
        entityId: intent.from,
        fieldPath: [],
      }
      ctx.conflicts.push({
        id: conflictId(loc, 'rename'),
        kind: 'rename',
        location: loc,
        base: undefined,
        ours: intent.to,
        theirs: intent.from,
        options: optionsFor('rename'),
        message: `两侧都把「${intent.from}」改名，目标 id 冲突`,
      })
    }
  }
  for (const intent of options.theirsIntents ?? []) {
    const outcome = renameInTree(normalizedOurs, intent)
    if (outcome === 'applied') appliedIntents.push(intent)
    if (outcome === 'conflict') {
      const loc: MergeLocation = {
        docId: intent.docId,
        section: intent.section,
        entityId: intent.from,
        fieldPath: [],
      }
      ctx.conflicts.push({
        id: conflictId(loc, 'rename'),
        kind: 'rename',
        location: loc,
        base: undefined,
        ours: intent.to,
        theirs: intent.from,
        options: optionsFor('rename'),
        message: `两侧都把「${intent.from}」改名，目标 id 冲突`,
      })
    }
  }

  const knownDocs = new Set([
    ...Object.keys(base),
    ...Object.keys(ours),
    ...Object.keys(theirs),
    ...(options.knownDocs ?? []),
  ])
  const raw: WorkingTree = {}
  for (const docId of [...knownDocs].sort()) {
    const merged = mergeDoc(
      base[docId] === undefined ? MISSING : base[docId],
      normalizedOurs[docId] === undefined ? MISSING : normalizedOurs[docId],
      normalizedTheirs[docId] === undefined ? MISSING : normalizedTheirs[docId],
      docId,
      ctx,
    )
    if (merged) raw[docId] = merged
  }

  // setAt 会原地写，先脱离三方输入的引用共享
  const tree = structuredClone(raw)
  const danglingRefs = findDanglingRefs(tree, knownDocs)
  const trees = [base, ours, theirs] as const

  for (const ref of danglingRefs) {
    const id = conflictId(ref.location, 'dangling-ref')
    const resolution = ctx.resolutions.get(id)
    if (resolution) {
      setValueAt(tree, ref.location, resolvedValue(resolution, trees, ref.location, ctx.prefer))
      continue
    }
    ctx.conflicts.push({
      id,
      kind: 'dangling-ref',
      location: ref.location,
      base: cell(valueAt(base, ref.location)),
      ours: cell(valueAt(ours, ref.location)),
      theirs: cell(valueAt(theirs, ref.location)),
      options: optionsFor('dangling-ref'),
      message: `「${ref.location.docId}/${ref.location.section}」的 ${ref.field} 引用了已不存在的 ${ref.refId}`,
    })
  }

  return { tree, conflicts: ctx.conflicts, danglingRefs, appliedIntents }
}
