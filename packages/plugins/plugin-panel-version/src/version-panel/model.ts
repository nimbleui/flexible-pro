import type {
  Commit,
  DiffResult,
  EntityChange,
  MergeConflict,
  MergeConflictKind,
  MergeResolution,
  ObjectHash,
  VersionHead,
} from '@lc/contracts'

/**
 * 版本面板的纯展示模型。
 *
 * 面板组件与 composable 只负责 Vue 响应式和 IO，所有「怎么分组、怎么排序、
 * 裁决草稿能不能提交」都放在这里：这些规则既要单测，也不该被渲染时序影响。
 */

/** 冲突严重度：必须裁决（blocking）与可先接受默认（review）两档。 */
export type ConflictSeverity = 'blocking' | 'review'

/**
 * 必须裁决与可先接受默认两档。
 *
 * `both-modified` / `delete-modify` / `add-add` 直接决定内容取舍，混在一份等权列表里
 * 会诱导用户一把点「全部采用我的」；`order` / `dangling-ref` / `rename` 更适合分组抽查，
 * 由 `withReviewDefaults()` 预填缺省裁决。
 */
const BLOCKING_KINDS: ReadonlySet<MergeConflictKind> = new Set([
  'both-modified',
  'delete-modify',
  'add-add',
])

/** 判断冲突严重度：落入必须裁决集合的为 blocking，其余为 review。 */
export function conflictSeverity(kind: MergeConflictKind): ConflictSeverity {
  return BLOCKING_KINDS.has(kind) ? 'blocking' : 'review'
}

/** 按严重度分好的两组冲突。 */
export interface ConflictGroups {
  /** 必须裁决的冲突：直接决定内容取舍 */
  blocking: MergeConflict[]
  /** 可先接受默认、留待分组抽查的冲突 */
  review: MergeConflict[]
}

/** 按严重度分组，组内保持内核给出的稳定顺序。 */
export function groupConflicts(conflicts: readonly MergeConflict[]): ConflictGroups {
  const groups: ConflictGroups = { blocking: [], review: [] }
  for (const conflict of conflicts) {
    groups[conflictSeverity(conflict.kind)].push(conflict)
  }
  return groups
}

/**
 * review 档冲突的缺省裁决。
 *
 * 取 `ours` 与内核一致：`decide()` 在没有裁决时返回的就是 `ctx.prefer`（缺省 `ours`），
 * 预填成别的值等于另立一套策略。
 */
export const REVIEW_DEFAULT_CHOICE: MergeResolution['choice'] = 'ours'

/**
 * 为 review 档冲突预填缺省裁决，已有的选择不覆盖。
 *
 * 内核要求**所有**冲突都被裁决后才落盘，而 review 档的定位是「先接受默认再抽查」
 * （方案 §11.2）。不预填的话，用户即使只关心 blocking 那几条也会被「尚未裁决」挡住，
 * 分级就退化成纯展示。预填不等于放行坏数据：`dangling-ref` 接受默认后若引用仍然悬空，
 * 注入的 `validateWorkingTree` 会报错（`checkNodeChildRefs` 等），`MergePlan.status`
 * 变成 `invalid`，内核一个对象都不写。
 */
export function withReviewDefaults(
  conflicts: readonly MergeConflict[],
  choices: Readonly<Record<string, MergeResolution['choice']>>,
): Record<string, MergeResolution['choice']> {
  const next: Record<string, MergeResolution['choice']> = { ...choices }

  for (const conflict of conflicts) {
    if (conflictSeverity(conflict.kind) !== 'review') continue
    if (next[conflict.id] !== undefined) continue
    next[conflict.id] = REVIEW_DEFAULT_CHOICE
  }

  return next
}

/**
 * 一个写动作按钮的可用性。
 *
 * `allowed` 与 `reason` 总是一起用：置灰而不说原因，用户只会反复点。
 */
export interface ActionAvailability {
  /** 按钮是否可点 */
  allowed: boolean
  /** 不可点的原因，文案可直接展示；可点时为空串 */
  reason: string
}

/**
 * 提交按钮的可用性。
 *
 * 三条判据全部来自内核给出的 `head`，不在面板里重新推导：会话未就绪、游离 HEAD
 * （内核要求先建分支）、只读查看态（提交会落到正在查看的分支上，内核会拒绝）。
 */
export function commitAvailability(head: VersionHead | undefined): ActionAvailability {
  if (head === undefined) return { allowed: false, reason: '版本库会话尚未就绪' }
  if (head.branch === undefined) return { allowed: false, reason: '游离 HEAD 需先建分支再提交' }

  if (head.viewOnly) {
    const draft = head.draftBranch ?? '切出前的分支'
    return {
      allowed: false,
      reason: `正在查看 ${head.branch}，草稿仍属于 ${draft}；检出回 ${draft} 才能提交`,
    }
  }

  return { allowed: true, reason: '' }
}

/**
 * 合并按钮的可用性。
 *
 * 只看宿主能否替换工作区：不能替换时合并结果写不回草稿，下一次保存就会把它静默撤销，
 * 内核因此一律拒绝落合并提交（`mergePreview` 是只读的，不受影响）。工作区脏不脏不在
 * 此列——那是用户先提交就能解除的临时状态，交给内核报错更准确。
 */
export function mergeAvailability(head: VersionHead | undefined): ActionAvailability {
  if (head === undefined) return { allowed: false, reason: '版本库会话尚未就绪' }

  return head.workingTreeReplaceable
    ? { allowed: true, reason: '' }
    : {
        allowed: false,
        reason: '合并结果写不回草稿，宿主暂不支持落合并提交；可用预览查看结果与冲突',
      }
}

/** 完整 hash 只用于定位；列表里展示前 8 位，与 git 的 short hash 习惯一致。 */
export function shortHash(hash: string): string {
  return hash === '' ? '—' : hash.slice(0, 8)
}

/** 把 ISO 时间格式化为本地可读串；解析失败时原样返回。 */
export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 三方值的展示文本。
 *
 * 合并树的取值可能是任意 JSON，也可能含循环引用（人工裁决写进来的对象），
 * 因此格式化失败要退化成可读文本而不是抛错把冲突区带崩。
 */
export function formatValue(value: unknown): string {
  if (value === undefined) return '（无）'
  try {
    const text = JSON.stringify(value, null, 2)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/** 手工输入 JSON 的解析结果：成功带值，失败带原因。 */
export type ParseResult = { ok: true; value: unknown } | { ok: false; message: string }

/** 解析「编辑 JSON」输入；空串不是合法 JSON，也不当作 null 静默放过。 */
export function parseManualValue(text: string): ParseResult {
  if (text.trim() === '') return { ok: false, message: '手工裁决值不能为空' }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (cause) {
    return {
      ok: false,
      message: `JSON 解析失败：${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}

/** 历史列表的一行；由 `historyRows` 从提交映射而来。 */
export interface HistoryRow {
  /** 提交完整 hash */
  id: ObjectHash
  /** 展示用短 hash（前 8 位） */
  shortId: string
  /** 提交信息 */
  message: string
  /** 提交人 */
  author: string
  /** 格式化后的提交时间 */
  createdAt: string
  /** 是否为合并提交（父提交多于一个） */
  isMerge: boolean
  /** 父提交地址列表 */
  parents: ObjectHash[]
  /** 若本次提交为发布则为其发布号，否则缺省 */
  publishLabel?: string
}

/** 历史列表行；`log` 已按第一父链排序，这里不重排，避免打乱「谁接着谁」。 */
export function historyRows(commits: readonly Commit[]): HistoryRow[] {
  return commits.map((commit) => ({
    id: commit.id,
    shortId: shortHash(commit.id),
    message: commit.message,
    author: commit.author,
    createdAt: formatTime(commit.createdAt),
    isMerge: commit.parents.length > 1,
    parents: [...commit.parents],
    publishLabel: commit.publish?.label,
  }))
}

/** diff 在一个文档内按 section 聚出的分组。 */
export interface DiffSectionGroup {
  /** section 名 */
  section: string
  /** 该 section 内的实体级变更 */
  changes: EntityChange[]
}

/** diff 按文档聚出的分组；文档级新增/消失标记单独记录。 */
export interface DiffDocGroup {
  /** 文档 id */
  docId: string
  /** 文档内各 section 的分组 */
  sections: DiffSectionGroup[]
  /** 该文档在本次 diff 中为整体新增 */
  added: boolean
  /** 该文档在本次 diff 中整体消失 */
  removed: boolean
}

/**
 * diff 按「文档 → section」分组。
 *
 * `changes` 已按 docId / section / entityId 排好序，但 `addedDocs` / `removedDocs`
 * 是另外两个数组，三个来源之间并不保证文档顺序。最终按 docId 做一次确定性排序，
 * 否则同一份 diff 的文档块顺序会随输入来源变化，用户没法逐次对照；组内仍只做连续
 * 切分、不重排实体行。
 */
export function groupDiff(diff: DiffResult): DiffDocGroup[] {
  const groups: DiffDocGroup[] = []
  const byDoc = new Map<string, DiffDocGroup>()

  const docOf = (docId: string): DiffDocGroup => {
    let group = byDoc.get(docId)
    if (!group) {
      group = { docId, sections: [], added: false, removed: false }
      byDoc.set(docId, group)
      groups.push(group)
    }
    return group
  }

  for (const docId of diff.addedDocs) docOf(docId).added = true
  for (const docId of diff.removedDocs) docOf(docId).removed = true

  for (const change of diff.changes) {
    const group = docOf(change.docId)
    let section = group.sections[group.sections.length - 1]
    if (!section || section.section !== change.section) {
      section = { section: change.section, changes: [] }
      group.sections.push(section)
    }
    section.changes.push(change)
  }

  return groups.sort((left, right) =>
    left.docId < right.docId ? -1 : left.docId > right.docId ? 1 : 0,
  )
}

/** 变更条数，用于空态与折叠标题。 */
export function diffCount(diff: DiffResult): number {
  return diff.changes.length + diff.addedDocs.length + diff.removedDocs.length
}

/** 面板上的裁决草稿：每个冲突的选择与手工输入文本。 */
export interface ResolutionDraft {
  /** conflictId → 用户选择；缺项即尚未裁决 */
  choices: Readonly<Record<string, MergeResolution['choice']>>
  /** conflictId → `manual` 时输入的 JSON 文本 */
  manual: Readonly<Record<string, string>>
}

/** 由裁决草稿构建内核可消费决议的结果：成功带决议列表，失败带原因。 */
export type ResolutionResult =
  { ok: true; resolutions: MergeResolution[] } | { ok: false; message: string }

/**
 * 把面板上的裁决草稿转成内核可消费的 `MergeResolution[]`。
 *
 * 任一冲突未裁决、或 `manual` 的 JSON 不合法都整批拒绝：内核的约定是
 * 「冲突未裁决完时一个对象都不写」，UI 不能靠补默认值绕过它。
 *
 * `manual.value` 是冲突 `location` 处的值（字段级），不是整个实体，
 * 因此这里原样使用用户输入的 JSON，不额外包一层。
 */
export function buildResolutions(
  conflicts: readonly MergeConflict[],
  draft: ResolutionDraft,
): ResolutionResult {
  const resolutions: MergeResolution[] = []

  for (const conflict of conflicts) {
    const choice = draft.choices[conflict.id]
    if (choice === undefined) {
      return { ok: false, message: `冲突「${conflictLocation(conflict)}」尚未裁决` }
    }

    if (choice !== 'manual') {
      resolutions.push({ conflictId: conflict.id, choice })
      continue
    }

    const parsed = parseManualValue(draft.manual[conflict.id] ?? '')
    if (!parsed.ok) {
      return { ok: false, message: `冲突「${conflictLocation(conflict)}」：${parsed.message}` }
    }
    resolutions.push({ conflictId: conflict.id, choice, value: parsed.value })
  }

  return { ok: true, resolutions }
}

/**
 * 冲突位置的可读标签；叶子 section 的 entityId 为空串时用 section 名代替。
 *
 * 面向用户的一切文案都用它，**不要展示 `conflict.id`**：那不是内容地址而是
 * `kind:docId:section:entityId:fieldPath` 拼出来的定位串，`shortHash` 截前 8 位只会得到
 * `both-mod` / `dangling` 这种碎片。它的用途是按 `MergeResolution.conflictId` 对号入座。
 */
export function conflictLocation(conflict: MergeConflict): string {
  const { docId, section, entityId, fieldPath } = conflict.location
  const parts = [docId, section, entityId, ...fieldPath].filter((part) => part !== '')
  return parts.join(' / ')
}
