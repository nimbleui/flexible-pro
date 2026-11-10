/**
 * 版本控制契约。
 *
 * 只放类型：数据模型、服务接口、存储适配器与工作区桥接形状。
 * 服务面按能力组合（`VersionServiceCore` / `VersionServiceMerge`），发布与环境绑定
 * 尚未纳入——提前写满接口会逼出 `Not implemented` 伪实现。
 */
import type { Disposable } from '@lc/kernel'
import type { ValidationIssue } from '@lc/schema'

/** 内容地址：SHA-256 摘要前 160 bit 的 40 字符小写十六进制。 */
export type ObjectHash = string

/** 可版本化的文档种类，与项目五类资产一一对应。 */
export type VersionDocKind = 'page' | 'flow' | 'function' | 'component' | 'api'

/** 可写入对象存储的两类不可变对象，判别位是各自的 `kind`。 */
export type VersionObject = SectionObject | DocumentObject

/**
 * 一个 section 的内容对象。
 *
 * 存规范化 JSON 文本而不是 JS 对象：文本才是 hash 的输入，反序列化再序列化
 * 会引入键序差异，等于自己破坏自己的寻址依据。
 */
export interface SectionObject {
  /** 判别位：始终为 'section'，用于区分两类对象。 */
  kind: 'section'
  /**
   * 内容地址，由 `hashText(canonicalJson({ docId, section, content }))` 得出。
   *
   * 命名空间必须入 hash：对象自带 `docId` / `section` 元数据，而存储的 fail-closed
   * 检查要求同地址对象逐字段一致；只按 content 取址时，两个不同文档的同值 section
   * （如 `{}`）会算出同一地址却写出两个不同对象，被误判成规范化失效。
   */
  hash: ObjectHash
  /** 所属文档 id */
  docId: string
  /** 文档顶层字段名，与 `SchemaPatch` 路径首段一致 */
  section: string
  /** 规范化 JSON 文本 */
  content: string
  /** 字节数，供容量统计与 GC 排序，不参与 hash */
  size: number
}

/**
 * 一个文档的对象清单（git tree 的对应物）。
 *
 * 只存 section → hash，不存内容：同一份 nodes 在 100 个提交里只有一份字节。
 * 缺键表示该 section 在此版本不存在，而不是空值。
 */
export interface DocumentObject {
  /** 判别位：始终为 'document'，用于区分两类对象。 */
  kind: 'document'
  /** 本清单的内容地址，由 `canonicalHash` 得出 */
  hash: ObjectHash
  /** 文档种类，决定校验与 diff 的实体规则 */
  docKind: VersionDocKind
  /** 各 section 的内容地址 */
  sections: Record<string, ObjectHash>
  /** 文档结构版本，与版本库格式版本是两个独立的迁移轴 */
  docSchemaVersion: string
}

/** 项目内全部文档的当前内容地址（git root tree 的对应物）。 */
export interface CommitTree {
  /** 文档 id → `DocumentObject.hash`；缺键即该文档在此提交中不存在 */
  docs: Record<string, ObjectHash>
}

/**
 * 一次提交的意图记录。
 *
 * 存在的唯一理由：重命名对内容 diff 不可见（旧键消失 + 新键出现），
 * 不显式记录，合并时就会把改名当成删除。提交时只记录，合并时才消费。
 */
export interface CommitIntent {
  /** 改名来源的实体 id（如节点 id） */
  from: string
  /** 改名目标的实体 id */
  to: string
  /** 实体所属文档 id */
  docId: string
  /** 实体所在 section 名 */
  section: string
}

/** 发布凭据：把「这次发布当时能不能跑」钉死在提交上。 */
export interface PublishReceipt {
  /** 人读发布号，不参与寻址 */
  label: string
  /** 发布闸门结果，逐条留痕 */
  issues: ValidationIssue[]
  /** 冻结的请求环境内容地址；环境值不入文档，但发布必须定版 */
  environmentHash: ObjectHash
  /** 发布人标识 */
  publishedBy: string
}

/** 一个不可变提交。 */
export interface Commit {
  /** 由 `canonicalHash(提交头)` 得出，是唯一权威编号 */
  id: ObjectHash
  /** 归属版本库 id，等于 projectId */
  repoId: string
  /** 0 个 = 根提交，1 个 = 普通，≥2 个 = 合并提交（第 0 个为当前 HEAD，第 1 个为被合入目标） */
  parents: ObjectHash[]
  /** 本提交的树，记录各文档的内容地址 */
  tree: CommitTree
  /** 提交信息 */
  message: string
  /** 提交人标识 */
  author: string
  /** ISO 时间字符串，不参与 hash 计算 */
  createdAt: string
  /** 相对第一父提交的改名清单 */
  intents?: CommitIntent[]
  /** 有值即该提交是一次正式发布 */
  publish?: PublishReceipt
}

/** 可变引用。ref 表是版本库里唯一允许原地更新的地方。 */
export interface Ref {
  /** 引用全名，如 `refs/heads/main` */
  name: string
  /** 指向的对象地址 */
  target: ObjectHash
  /** 最近一次更新时间（ISO 字符串） */
  updatedAt: string
  /** 最近一次移动 ref 的源头标识 */
  movedBy: string
}

/** 分支元数据，与 Ref 分开存：分支可以删、可以保护，tag 不需要这些。 */
export interface BranchMeta {
  /** 分支名 */
  name: string
  /** 受保护分支禁止直接提交，只接受合并与发布 */
  protected: boolean
  /** 从哪个提交切出，用于展示「落后主干多少」 */
  base: ObjectHash
}

/** 工作区里一份文档的当前内容。 */
export interface VersionDocument {
  /** 文档种类 */
  kind: VersionDocKind
  /** 文档结构版本，随 `DocumentObject` 一起定版 */
  docSchemaVersion: string
  /** section 名 → 值；缺键表示此版本不存在该 section */
  sections: Record<string, unknown>
}

/**
 * 工作区全量快照：文档 id → 文档内容。
 *
 * 由宿主在提交时提供、在检出时接收；宿主接入 `document:change` 后由 index 聚合，
 * 版本内核因此不依赖 Vue、Realm 或任何浏览器 API。
 */
export type WorkingTree = Record<string, VersionDocument>

/**
 * 一个实体在两侧的取值。
 *
 * `base` / `ours` 在 diff 场景分别表示 from / to；合并场景才填 `theirs`。
 * 三格而不是只存 hash：冲突解决的最低可用形态是看清三方各是什么。
 */
export interface EntityChange {
  /** 实体所属文档 id */
  docId: string
  /** 实体所在 section 名 */
  section: string
  /** 字典/数组用实体键；叶子字段 section 用 JSON Pointer 风格的 `/字段名` */
  entityId: string
  /** 变更类型：新增 / 删除 / 修改 */
  change: 'added' | 'removed' | 'modified'
  /** 实体展示名，由物料元数据或文档标题解析（可选） */
  label?: string
  /** 基线侧取值（diff 的 from） */
  base?: unknown
  /** 当前侧取值（diff 的 to / 合并的 ours） */
  ours?: unknown
  /** 被合入侧取值（仅合并冲突场景存在） */
  theirs?: unknown
}

/** 两个提交之间的差异。 */
export interface DiffResult {
  /** 差异起点提交地址 */
  from: ObjectHash
  /** 差异终点提交地址 */
  to: ObjectHash
  /** 实体级变更，按 docId → section → entityId 排序，UI 不必再排 */
  changes: EntityChange[]
  /** 在终点新增的文档 id 列表 */
  addedDocs: string[]
  /** 在终点消失的文档 id 列表 */
  removedDocs: string[]
  /** 内容完全未变的文档 id，供 UI 折叠 */
  unchangedDocs: string[]
}

/** 当前检出状态。 */
export interface VersionHead {
  /** 归属版本库 id */
  repoId: string
  /** HEAD 指向的分支名；游离态（直接检出提交）时为 undefined */
  branch?: string
  /** 当前 HEAD 指向的提交地址 */
  commit: ObjectHash
  /** working copy 与 HEAD 不一致即为脏，不看 `model.version` */
  hasUncommitted: boolean
  /**
   * 宿主能否用 `writeWorkingTree` 真正替换工作区，等于 `VersionServiceOptions` 的同名项。
   *
   * `false` 时 `merge` 与 `restoreDoc` 恒不可用（结果写不回草稿），UI 应据此置灰而不是
   * 等用户点了才吃 `read-only-view`。
   */
  workingTreeReplaceable: boolean
  /**
   * 只读查看态：HEAD 与工作区不同源，`commit` 会被拒绝。
   *
   * 只可能在 `workingTreeReplaceable` 为 `false` 时为真。判据由内核给出（同时比分支与
   * 提交），UI 不要自行从 `branch` 推导——两条分支指向同一提交时只比分支会漏判。
   */
  viewOnly: boolean
  /**
   * 工作区实际归属的分支；`viewOnly` 为真时用于告诉用户检出回哪里才能提交。
   *
   * 非查看态下等于 `branch`；工作区归属本身就是游离态时为 undefined。
   */
  draftBranch?: string
}

/** 一次提交涉及的文档改动集合。 */
export interface DocChangeSet {
  /** 文档 id → 变化的 section 名列表；文档整体消失时值为空数组 */
  sections: Record<string, string[]>
}

/** 一次提交的输入。 */
export interface CommitInput {
  /** 空白即拒绝 */
  message: string
  /** 缺省由 `VersionServiceOptions.author` 补齐 */
  author?: string
  /** 相对上一提交的改名清单 */
  intents?: CommitIntent[]
  /**
   * 已知改动时显式传入，用于跳过未变文档的规范化；
   * 缺省由内核比较 working copy 与 HEAD 推导，不提供绕过 ref CAS 的入口。
   */
  changes?: DocChangeSet
}

/** 历史查询条件。 */
export interface LogQuery {
  /** 起点，缺省为 HEAD */
  from?: ObjectHash
  /** @default 50 */
  limit?: number
  /** 分页偏移，与 `limit` 配合翻页 */
  offset?: number
  /** true = 只看第一父链；false = 展开全部祖先 @default true */
  firstParent?: boolean
}

/** 版本库变化事件；进程内通知，可丢弃，不等同于审计留痕。 */
export type VersionEvent =
  | { kind: 'commit'; commit: Commit }
  | { kind: 'ref'; name: string; target: ObjectHash }
  | { kind: 'head'; head: VersionHead }

/* ── 三方合并 ─────────────────────────────────────────────────────────── */

/** 冲突形态。`dangling-ref` 是低代码特有：实体本身没冲突，引用却指向另一侧删掉的实体。 */
export type MergeConflictKind =
  'both-modified' | 'delete-modify' | 'add-add' | 'order' | 'rename' | 'dangling-ref'

/** 冲突在合并树里的唯一定位；冲突面板靠它把三方值摆回原处。 */
export interface MergeLocation {
  /** 冲突所属文档 id */
  docId: string
  /** 冲突所在 section 名 */
  section: string
  /** 实体 id；叶子 section 或整个文档用空串 */
  entityId: string
  /** 实体内部的字段路径；空数组表示整个实体或整个 section */
  fieldPath: readonly string[]
}

/**
 * 一次人工裁决。`manual` 必须给 `value`；其余选择忽略它。
 *
 * `value` 是**该冲突 `location` 处的值**，不是整个文档或整个实体：合并按
 * `section → entityId → fieldPath` 逐层下钻，例如两侧改了同一个节点的 `x` 字段，
 * 冲突就定位在 `['x']`，`value` 应是那个字段的最终值。
 */
export interface MergeResolution {
  /** 裁决对应的冲突 id */
  conflictId: string
  /** 裁决方式：取当前 / 取被合入 / 取基线 / 手动指定 */
  choice: 'ours' | 'theirs' | 'base' | 'manual'
  /** `manual` 时必填，为 `location` 处的最终值；其余选择忽略 */
  value?: unknown
}

/** 一个冲突。三格内容全保留，UI 不必回查对象表。 */
export interface MergeConflict {
  /** 由 location 派生；同一组三方输入稳定不变，裁决按它对号入座 */
  id: string
  /** 冲突形态 */
  kind: MergeConflictKind
  /** 冲突在合并树中的定位 */
  location: MergeLocation
  /** 基线侧取值 */
  base: unknown
  /** 当前侧取值 */
  ours: unknown
  /** 被合入侧取值 */
  theirs: unknown
  /** 用户可调用的裁决方式列表 */
  options: Array<MergeResolution['choice']>
  /** 给用户的冲突说明文案 */
  message: string
}

/** 指向已不存在实体的引用。 */
export interface DanglingRef {
  /** 引用所在的定位 */
  location: MergeLocation
  /** 引用所在的字段名，如 `children` / `actionIds` */
  field: string
  /** 被引用但已不存在的实体 id */
  refId: string
}

/** 合并产物校验状态。未注入校验器时恒为 `skipped`，绝不谎报通过。 */
export type MergeValidation = 'passed' | 'failed' | 'skipped'

/**
 * 合并的可执行计划：先算，再让用户确认，最后落盘。
 *
 * `tree` 的冲突位暂取 `ours`，只是给 UI 预览；真正的最终值由 `merge()` 带裁决重算。
 */
export interface MergePlan {
  /** 第一父：当前 HEAD */
  ours: ObjectHash
  /** 第二父：被合入的目标提交 */
  theirs: ObjectHash
  /** LCA；criss-cross 时多个，折叠成一棵虚拟基线树但不落盘 */
  bases: ObjectHash[]
  /** 计划状态：干净 / 有冲突 / 非法 */
  status: 'clean' | 'conflicted' | 'invalid'
  /** 暂定树，冲突位取 ours，仅供预览 */
  tree: WorkingTree
  /** 检测到的冲突清单 */
  conflicts: MergeConflict[]
  /** 悬空引用清单 */
  danglingRefs: DanglingRef[]
  /** 校验问题清单 */
  issues: ValidationIssue[]
  /** 校验状态 */
  validation: MergeValidation
  /** 已自动应用的改名意图，供 UI 说明"另一侧的插入落到了新 id" */
  appliedIntents: CommitIntent[]
  /** 合并提交信息 */
  message: string
}

/** `merge()` 的结果。未裁决完或校验不通过时不写任何对象。 */
export interface MergeResult {
  /** 合并结果状态 */
  status: 'merged' | 'conflicted' | 'invalid' | 'up-to-date' | 'fast-forward'
  /** `merged` 时有值；`fast-forward` / `up-to-date` 不产生新提交 */
  commit?: Commit
  /** `fast-forward` 时当前分支被移动到的提交 */
  target?: ObjectHash
  /** 本次合并对应的计划 */
  plan: MergePlan
}

/**
 * 注入既有 schema 校验器（`validateDocument` / `validateFlow` 的包装）。
 *
 * Core 不认识 `PageSchema` / `FlowDefinition` 的具体形状，也不另写一套规则；
 * 不注入时 `MergePlan.validation` 为 `skipped`，引用完整性检查仍照常执行。
 */
export type MergeValidate = (
  tree: WorkingTree,
) => readonly ValidationIssue[] | Promise<readonly ValidationIssue[]>

/** 三方合并能力集。 */
export interface VersionServiceMerge {
  /** 只算不写：给出三方值、冲突清单与暂定树 */
  mergePreview(target: string): Promise<MergePlan>
  /**
   * 落一次合并提交。冲突未裁决完或校验不通过时返回对应 `plan`，不写任何对象；
   * 目标已是当前祖先返回 `up-to-date`，可快进则移动分支 ref 而不造合并提交。
   *
   * @param target 待合并进当前 HEAD 的分支名、ref 全名或提交地址
   * @param input 可选的提交信息与人工裁决；缺省时沿用默认消息、自动合并可解部分
   */
  merge(
    target: string,
    input?: { message?: string; resolutions?: readonly MergeResolution[] },
  ): Promise<MergeResult>
}

/** 当前已落地的完整服务面。 */
export type VersionService = VersionServiceCore & VersionServiceMerge

/**
 * 基础服务能力集：提交、历史、diff、分支、检出、单文档恢复。
 *
 * 所有 IO 一律 async：IndexedDB 与未来的服务端都是异步的，现在写成同步将来必改契约面。
 */
export interface VersionServiceCore {
  readonly head: VersionHead
  /** 提交当前工作区；无变化时返回 undefined 且不写任何对象 */
  commit(input: CommitInput): Promise<Commit | undefined>
  /** 提交历史，按时间倒序；可用 `LogQuery` 限定起点、数量与是否只看第一父链 */
  log(query?: LogQuery): Promise<Commit[]>
  /** 两个提交之间的差异，给出实体级变更与文档增删 */
  diff(from: ObjectHash, to: ObjectHash): Promise<DiffResult>
  /** 当前版本库的全部分支元数据 */
  listBranches(): Promise<BranchMeta[]>
  /** name 已存在即拒绝，不覆盖 */
  createBranch(name: string, from: ObjectHash): Promise<BranchMeta>
  /** 检出分支名、ref 全名或提交地址；工作区有未提交内容时需 force */
  checkout(ref: string, options?: { force?: boolean }): Promise<VersionHead>
  /** 把单个文档恢复到某提交，不产生全局回滚，也不立即落提交 */
  restoreDoc(docId: string, commit: ObjectHash): Promise<void>
  /** 订阅版本库变化（提交 / ref / HEAD）；返回可释放的句柄 */
  onDidChange(listener: (event: VersionEvent) => void): Disposable
  /**
   * 重新比较 working copy 与 HEAD 并刷新 `head.hasUncommitted`。
   *
   * 内核不订阅 `document:change`，工作区在外部变化时不会自动感知；
   * 宿主的 tracker 每次 patch 后调用它即可，无需再改本接口。
   */
  refreshHead(): Promise<VersionHead>
}

/** 创建版本服务所需的宿主桥接；由宿主装配层注入真实实现。 */
export interface VersionServiceOptions {
  /** 版本库归属的项目 id，同时作为分库键 */
  repoId: string
  readWorkingTree(): Promise<WorkingTree> | WorkingTree
  writeWorkingTree(tree: WorkingTree): Promise<void> | void
  /** 起始检出的分支或 ref @default 'main' */
  initialRef?: string
  /** 提交人缺省值 @default 'unknown' */
  author?: string
  /** 时间源，便于测试；返回值不参与 commit hash */
  now?: () => string
  /** 注入既有 schema 校验器；不注入时 `MergePlan.validation` 为 `skipped` */
  validate?: MergeValidate
  /**
   * `writeWorkingTree` 是否会真正替换宿主工作区。
   *
   * 宿主还没有资产替换 API 时应传 `false`：此时 `checkout` 只移动内存 HEAD 供只读查看
   * （不持久化 HEAD，否则重启后会回到一个与草稿不同源的分支），`restoreDoc` / `merge`
   * 直接拒绝，且查看态下 `commit` 拒绝——工作区仍属于切出前的分支，放行会把无关草稿
   * 记到刚检出的分支上。
   * @default true
   */
  workingTreeReplaceable?: boolean
}

/** 版本对象存储的最小读写面。实现可以是内存、IndexedDB 或服务端。 */
export interface VersionStore {
  /** 对象是否已存在；用于写前探测，不读内容 */
  hasObject(repoId: string, hash: ObjectHash): Promise<boolean>
  /** 按地址取不可变对象；不存在返回 undefined */
  getObject(repoId: string, hash: ObjectHash): Promise<VersionObject | undefined>
  /**
   * 内容寻址写入：同 hash 且同内容视为已存在，跳过；
   * 同 hash 但内容不同必须抛错——那是确定性失效的信号，静默覆盖会把两份文档压成一份。
   */
  putObject(repoId: string, object: VersionObject): Promise<void>
  getCommit(repoId: string, id: ObjectHash): Promise<Commit | undefined>
  /**
   * 写入提交对象，与 `putObject` 同口径 fail-closed：同 id 且同内容视为已存在，跳过；
   * 同 id 但内容不同必须抛错。
   *
   * 这条不是实现细节而是接口要求：`createdAt` 不参与寻址，「同父 + 同树 + 同消息 + 同作者」
   * 的两次提交会撞同一 id 而对象不同，静默覆盖等于改写既有历史。所有适配器（内存 /
   * IndexedDB / 未来的服务端）必须给出同一条诊断，否则同一份数据会在单测里失败、
   * 在浏览器里悄悄坏掉。
   */
  putCommit(repoId: string, commit: Commit): Promise<void>
  /** 按全名取引用；不存在返回 undefined */
  getRef(repoId: string, name: string): Promise<Ref | undefined>
  /**
   * 比较并交换：仅当 ref 当前值等于 expected 时才写入。
   * expected 为 undefined 表示「不存在 → 首次写入」，用于初始化与 tag 的 create-only。
   * @param repoId 版本库 id
   * @param name 引用全名
   * @param expected 期望的当前值；undefined 表示首次写入
   * @param next 要写入的新值
   * @returns 成功时返回新 Ref；不匹配返回 undefined，由调用方发起拉取-合并重试
   */
  casRef(
    repoId: string,
    name: string,
    expected: ObjectHash | undefined,
    next: ObjectHash,
  ): Promise<Ref | undefined>
  /** 全部引用；初始化与冲突解决时用于枚举分支 / tag */
  listRefs(repoId: string): Promise<Ref[]>
  /** GC 用：全部对象地址，供可达性标记 */
  scanObjectHashes(repoId: string): Promise<ObjectHash[]>
  /** 分支元数据与 Ref 分开存 */
  getBranchMeta(repoId: string, name: string): Promise<BranchMeta | undefined>
  /** 写入分支元数据；与 `putRef` 分开，避免 ref 表被元数据拖大 */
  putBranchMeta(repoId: string, meta: BranchMeta): Promise<void>
}

/* ── 宿主面板桥接 ─────────────────────────────────────────────────────── */

/**
 * 版本库灰度档位。
 *
 * 放在契约层而不是 `@lc/service-version`：面板插件、状态栏与宿主装配层都要读它，
 * 让它们为了一个字符串联合去依赖整个内核包会形成反向依赖。
 */
export type VersionMode = 'off' | 'shadow' | 'on'

/** 版本面板的五个分区；命令与面板之间只传这一个联合，不传组件内部状态。 */
export type VersionPanelSection = 'history' | 'diff' | 'branches' | 'releases' | 'conflicts'

/** 命令打开版本面板时的载荷。 */
export interface VersionOpenPayload {
  /** 要聚焦的分区 */
  section: VersionPanelSection
  /** merge 命令附带：打开后立刻对指定目标做一次合并预览 */
  previewTarget?: string
}

/** 宿主发布快照摘要；插件不 import 宿主模型，只读这些字段。 */
export interface VersionReleaseSummary {
  /** 发布序号，单调递增 */
  revision: number
  /** 发布时间（ISO 字符串） */
  createdAt: string
  /** 是否为当前线上版本 */
  current: boolean
}

/**
 * 宿主版本服务（应用级 Context 服务，按 projectId 惰性分库）。
 *
 * 存在的理由：版本库会话由宿主装配（IndexedDB、五类资产、发布存储都在宿主），
 * 而面板插件与状态栏不能反向 import 宿主。服务只暴露面板真正需要的读写面，
 * 不把 `ProjectReleaseAssets` 这类宿主数据结构泄漏进契约。
 *
 * `off` 档位下服务仍然存在（`mode === 'off'`），但 `session()` 返回 undefined：
 * UI 因此能明确显示「版本控制未启用」，而不是渲染一块空白面板。
 */
export interface VersionHostService {
  readonly mode: VersionMode
  /** off 时返回 undefined；其余档位惰性创建并返回该项目的完整版本服务 */
  session(projectId: string): Promise<VersionService> | undefined
  /** commit / ref / head 变化的进程内通知，供面板与状态栏刷新；不等同于审计留痕 */
  onDidChange(listener: () => void): Disposable
  /** 当前项目的发布快照摘要，按发布号升序 */
  releases(projectId: string): readonly VersionReleaseSummary[]
  /** 发布闸门结果；与发布页复用同一套校验，避免两处规则漂移 */
  checkRelease(projectId: string): readonly ValidationIssue[]
  /** 发布当前内容并返回新发布号；存在阻断问题时抛错，文案可直接展示 */
  publish(projectId: string): number
  /** 回滚到某个已发布版本；只移动线上指针，不回写资产 */
  rollback(projectId: string, revision: number): void
}
