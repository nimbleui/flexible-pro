import type {
  Commit,
  CommitIntent,
  MergePlan,
  MergeResolution,
  MergeValidate,
  ObjectHash,
  ValidationIssue,
  VersionStore,
  WorkingTree,
} from '@lc/contracts'
import { collectCommits, isAncestor, mergeBases } from './dag'
import { VersionError } from './errors'
import { mergeTrees } from './merge'
import { buildTree, commitIdOf, readTreeAt } from './object'
import { branchRef, tagRef } from './refs'

/**
 * 合并编排层：把对象存储里的三棵提交树取出来交给纯算法，再把结果写成合并提交。
 *
 * 与 `merge.ts` 的分工是刻意的：算法完全不认识 store，所以十万次随机属性测试
 * 可以只跑纯函数；这一层负责 DAG、ref、事件这些有副作用的东西。
 */

/** 解析分支短名、ref 全名、tag 或裸提交地址。 */
export async function resolveTarget(
  store: VersionStore,
  repoId: string,
  ref: string,
): Promise<ObjectHash> {
  const candidates = ref.startsWith('refs/') ? [ref] : [branchRef(ref), tagRef(ref)]
  for (const name of candidates) {
    const found = await store.getRef(repoId, name)
    if (found) return found.target
  }
  if (await store.getCommit(repoId, ref)) return ref
  throw new VersionError('invalid-input', `引用 ${ref} 不存在`)
}

/** 把一次提交还原成工作树；断链直接失败，不用空树冒充。 */
export async function treeOf(
  store: VersionStore,
  repoId: string,
  hash: ObjectHash,
): Promise<WorkingTree> {
  const commit = await store.getCommit(repoId, hash)
  if (!commit) throw new VersionError('missing-commit', `提交 ${hash} 不存在`)
  return readTreeAt(store, repoId, commit.tree)
}

/**
 * 收集 tip 相对基线新增的改名意图。
 *
 * 沿第一父链回溯：跨合并链的改名需要在合并提交上重新声明，否则对侧无法知道，
 * 这与「意图必须显式记录、不靠猜测」一致，不靠启发式推断。
 */
export async function collectIntents(
  store: VersionStore,
  repoId: string,
  bases: readonly ObjectHash[],
  tip: ObjectHash,
): Promise<CommitIntent[]> {
  const stop = new Set(bases)
  const seen = new Set<ObjectHash>()
  const result: CommitIntent[] = []
  let current: ObjectHash | undefined = tip

  while (current !== undefined && !stop.has(current) && !seen.has(current)) {
    seen.add(current)
    const commit = await store.getCommit(repoId, current)
    if (!commit) throw new VersionError('missing-commit', `提交 ${current} 不存在`)
    if (commit.intents) result.push(...commit.intents)
    current = commit.parents[0]
  }

  return result
}

/**
 * 虚拟基线：criss-cross 时把多个 LCA 两两折叠成一棵基线树，**不落盘**。
 *
 * 直接落盘会在 `log` 里出现用户从未创建过的提交，破坏"提交是人做的一次决定"这个语义。
 * 递归深度有上限，超过后退回单个 LCA，避免畸形 DAG 把合并拖成无限递归。
 */
export async function virtualBaseTree(
  store: VersionStore,
  repoId: string,
  bases: readonly ObjectHash[],
  depth = 0,
): Promise<WorkingTree> {
  if (bases.length === 0) return {}

  const first = bases[0]
  let acc = await treeOf(store, repoId, first)

  for (const other of bases.slice(1)) {
    const common = await mergeBases(store, repoId, first, other)
    let baseTree: WorkingTree = {}
    if (common.length > 1 && depth < 3) {
      baseTree = await virtualBaseTree(store, repoId, common, depth + 1)
    } else if (common.length > 0) {
      baseTree = await treeOf(store, repoId, common[0])
    }

    acc = mergeTrees(baseTree, acc, await treeOf(store, repoId, other), {
      prefer: 'ours',
    }).tree
  }

  return acc
}

/** 计算合并计划的选项；`resolutions` 与 `message` 为人工输入，`validate` 为可选注入。 */
export interface MergePlanOptions {
  /** 已应用的裁决；缺项表示沿用默认（自动合并可解的部分） */
  resolutions?: readonly MergeResolution[]
  /** 合并提交信息；缺省由调用方派生 */
  message?: string
  /** 注入既有 schema 校验器；不注入则 `validation` 为 `skipped` */
  validate?: MergeValidate
}

function blocking(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error')
}

/**
 * 只算不写：给出三方值、冲突清单与暂定树。
 *
 * `validate` 没注入时 `validation` 恒为 `skipped`——引用完整性（`dangling-ref`）由内核
 * 自己查，但 schema 级校验不能假装通过；由宿主装配层把 `validateDocument` / `validateFlow`
 * 的包装传进来即可复用既有规则，不另写一套。
 */
export async function computeMergePlan(
  store: VersionStore,
  repoId: string,
  ours: ObjectHash,
  theirs: ObjectHash,
  options: MergePlanOptions = {},
): Promise<MergePlan> {
  const bases = await mergeBases(store, repoId, ours, theirs)
  const [baseTree, oursTree, theirsTree, oursIntents, theirsIntents] = await Promise.all([
    virtualBaseTree(store, repoId, bases),
    treeOf(store, repoId, ours),
    treeOf(store, repoId, theirs),
    collectIntents(store, repoId, bases, ours),
    collectIntents(store, repoId, bases, theirs),
  ])

  const merged = mergeTrees(baseTree, oursTree, theirsTree, {
    resolutions: options.resolutions,
    oursIntents,
    theirsIntents,
    knownDocs: new Set([
      ...Object.keys(baseTree),
      ...Object.keys(oursTree),
      ...Object.keys(theirsTree),
    ]),
  })

  let issues: readonly ValidationIssue[] = []
  let validation: MergePlan['validation'] = 'skipped'
  if (options.validate) {
    issues = await options.validate(merged.tree)
    validation = blocking(issues) ? 'failed' : 'passed'
  }

  const status: MergePlan['status'] =
    merged.conflicts.length > 0 ? 'conflicted' : validation === 'failed' ? 'invalid' : 'clean'

  return {
    ours,
    theirs,
    bases,
    status,
    tree: merged.tree,
    conflicts: merged.conflicts,
    danglingRefs: merged.danglingRefs,
    issues: [...issues],
    validation,
    appliedIntents: merged.appliedIntents,
    message: options.message?.trim() || `合并 ${theirs.slice(0, 8)} 到 ${ours.slice(0, 8)}`,
  }
}

/** 当前 HEAD 与目标提交之间的三种 DAG 关系。 */
export async function mergeRelation(
  store: VersionStore,
  repoId: string,
  ours: ObjectHash,
  theirs: ObjectHash,
): Promise<'up-to-date' | 'fast-forward' | 'merge'> {
  const commits = await collectCommits(store, repoId, [ours, theirs])

  // isAncestor 在"相等"时也返回 true；两边相同时合并没有意义，按 up-to-date 处理
  if (ours === theirs || isAncestor(commits, theirs, ours)) return 'up-to-date'
  if (isAncestor(commits, ours, theirs)) return 'fast-forward'
  return 'merge'
}

/** CAS 移动当前分支 ref；被并发前移时失败而不是覆盖别人的提交。 */
export async function moveRef(
  store: VersionStore,
  repoId: string,
  branch: string,
  expected: ObjectHash | undefined,
  next: ObjectHash,
): Promise<void> {
  const moved = await store.casRef(repoId, branchRef(branch), expected, next)
  if (!moved) {
    throw new VersionError('conflict', `分支 ${branch} 已被前移，请重新预览合并`)
  }
}

/** 落一次双亲合并提交：先写对象与提交，最后 CAS 移动 ref。 */
export async function writeMergeCommit(
  store: VersionStore,
  repoId: string,
  branch: string,
  plan: MergePlan,
  author: string,
  now: () => string,
): Promise<Commit> {
  const { objects, commitTree } = buildTree(plan.tree)
  for (const object of objects) await store.putObject(repoId, object)

  const header = {
    repoId,
    parents: [plan.ours, plan.theirs],
    tree: commitTree,
    message: plan.message,
    author,
    createdAt: now(),
  }
  const commit: Commit = { id: commitIdOf(header), ...header }
  await store.putCommit(repoId, commit)
  await moveRef(store, repoId, branch, plan.ours, commit.id)

  return commit
}
