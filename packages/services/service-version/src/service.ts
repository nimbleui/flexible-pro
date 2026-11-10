import type {
  BranchMeta,
  Commit,
  CommitInput,
  DiffResult,
  LogQuery,
  MergePlan,
  MergeResolution,
  MergeResult,
  ObjectHash,
  VersionEvent,
  VersionHead,
  VersionService,
  VersionServiceOptions,
  VersionStore,
  WorkingTree,
} from '@lc/contracts'
import { canonicalJson } from '@lc/shared'
import { diffTrees } from './diff'
import { logCommits } from './dag'
import { VersionError } from './errors'
import {
  computeMergePlan,
  mergeRelation,
  moveRef,
  resolveTarget,
  treeOf,
  writeMergeCommit,
} from './merge-plan'
import { buildTree, commitIdOf, readDocument, readTreeAt } from './object'
import { DETACHED_PREFIX, HEAD_REF, MAIN_BRANCH, branchNameOf, branchRef, tagRef } from './refs'

/**
 * 创建项目级版本服务。
 *
 * 工作区读写由宿主以函数注入，内核因此不需要认识 Realm、Vue 或 `DocumentService`；
 * 宿主把这两个函数接到 `document:change` 聚合出的 index 上即可，不用改本文件。
 *
 * @param store 对象存储；本地用 `IdbVersionStore`，测试用 `MemoryVersionStore`
 * @param config 仓库 id 与工作区桥接
 * @returns 已按 `initialRef` 检出、脏状态已计算好的服务（提交核心 + 三方合并）
 */
export async function createVersionService(
  store: VersionStore,
  config: VersionServiceOptions,
): Promise<VersionService> {
  const repoId = config.repoId
  const clock = config.now ?? (() => new Date().toISOString())
  const listeners = new Set<(event: VersionEvent) => void>()

  // `initialRef` 是调用方的显式指定（测试 / 导入场景），优先于持久化的 HEAD。
  // 否则读 HEAD_REF：服务重启后应回到用户上次检出的分支，而不是静默回到 main。
  const persistedHead =
    config.initialRef === undefined ? (await store.getRef(repoId, HEAD_REF))?.target : undefined

  let branch: string | undefined
  let commitId: ObjectHash

  if (config.initialRef !== undefined) {
    const name = config.initialRef.startsWith('refs/')
      ? config.initialRef
      : branchRef(config.initialRef)
    branch = branchNameOf(name)
    commitId = (await store.getRef(repoId, name))?.target ?? ''
  } else if (persistedHead?.startsWith(DETACHED_PREFIX)) {
    branch = undefined
    commitId = persistedHead.slice(DETACHED_PREFIX.length)
  } else {
    const name = branchRef(persistedHead ?? MAIN_BRANCH)
    branch = branchNameOf(name)
    commitId = (await store.getRef(repoId, name))?.target ?? ''
  }

  let dirty = false

  // 宿主能否用 writeWorkingTree 真正替换工作区。资产替换 API 落地前，宿主只把树交给
  // 只读版本视图，草稿原封不动——此时 HEAD 与工作区可能不同源，必须拦住提交。
  const replaceable = config.workingTreeReplaceable ?? true
  // 工作区实际归属的分支与提交；replaceable 时恒等于当前 HEAD
  let draftBranch: string | undefined = branch
  let draftBase: ObjectHash = commitId
  let viewOnly = false

  /**
   * HEAD 移动后的状态收尾。
   *
   * 工作区被真正替换时，归属跟着 HEAD 前移、脏状态清零；只读查看态下工作区仍属于
   * `draftBranch`/`draftBase`，必须重算脏状态，并在两者不同源时禁止提交——否则一次保存
   * 就会把切出前的草稿记到刚检出的分支上。判据同时看分支与提交：两条分支指向同一个
   * 提交时，只比提交会漏掉「提交被改道到另一条分支」。
   */
  async function settleWorkingTree(target: ObjectHash): Promise<void> {
    commitId = target

    if (replaceable) {
      draftBranch = branch
      draftBase = target
      dirty = false
      viewOnly = false
      return
    }

    dirty = await computeDirty()
    viewOnly = branch !== draftBranch || target !== draftBase
  }

  function currentHead(): VersionHead {
    return {
      repoId,
      branch,
      commit: commitId,
      hasUncommitted: dirty,
      workingTreeReplaceable: replaceable,
      viewOnly,
      draftBranch,
    }
  }

  function emit(event: VersionEvent): void {
    for (const listener of [...listeners]) listener(event)
  }

  /**
   * 脏状态由 working copy 与 HEAD 的提交树比较得出，不看 `model.version`。
   *
   * 比较用规范化文本：两侧对象键序可能不同，但内容相同就不该算改动。
   */
  async function computeDirty(): Promise<boolean> {
    const { commitTree } = buildTree(await config.readWorkingTree())

    if (commitId === '') return Object.keys(commitTree.docs).length > 0

    const commit = await store.getCommit(repoId, commitId)
    if (!commit) throw new VersionError('missing-commit', `HEAD 提交 ${commitId} 不存在`)

    return canonicalJson(commitTree) !== canonicalJson(commit.tree)
  }

  async function resolveRef(ref: string): Promise<{
    target: ObjectHash
    branch?: string
  }> {
    const candidates = ref.startsWith('refs/') ? [ref] : [branchRef(ref), tagRef(ref)]

    for (const name of candidates) {
      const found = await store.getRef(repoId, name)
      if (found) return { target: found.target, branch: branchNameOf(name) }
    }

    if (await store.getCommit(repoId, ref)) return { target: ref }

    throw new VersionError('invalid-input', `引用 ${ref} 不存在`)
  }

  dirty = await computeDirty()

  const service: VersionService = {
    get head() {
      return currentHead()
    },

    async commit(input: CommitInput): Promise<Commit | undefined> {
      const message = input.message.trim()
      if (message === '') throw new VersionError('invalid-input', '提交消息不能为空')
      if (branch === undefined) {
        throw new VersionError('invalid-input', '游离 HEAD 需先建分支再提交')
      }

      const meta = await store.getBranchMeta(repoId, branch)
      if (meta?.protected) {
        throw new VersionError('protected', `分支 ${branch} 受保护，请通过合并提交`)
      }

      if (viewOnly) {
        throw new VersionError(
          'read-only-view',
          `HEAD 在 ${branch}（${commitId.slice(0, 8)}）而工作区仍属于 ` +
            `${draftBranch ?? '游离 HEAD'}（${draftBase.slice(0, 8)}）；` +
            '宿主尚不能替换工作区资产，请先检出回工作分支再提交',
        )
      }

      const { objects, commitTree } = buildTree(await config.readWorkingTree())
      const parentId = commitId
      const parent = parentId === '' ? undefined : await store.getCommit(repoId, parentId)
      if (parentId !== '' && !parent) {
        throw new VersionError('missing-commit', `父提交 ${parentId} 不存在`)
      }

      if (parent && canonicalJson(parent.tree) === canonicalJson(commitTree)) return undefined

      // 先落对象与提交、最后移动 ref：任何一步失败都不会让一个「半提交」变得可见
      for (const object of objects) await store.putObject(repoId, object)

      const header = {
        repoId,
        parents: parent ? [parent.id] : [],
        tree: commitTree,
        message,
        author: input.author ?? config.author ?? 'unknown',
        createdAt: clock(),
        ...(input.intents?.length ? { intents: input.intents } : {}),
      }
      const commit: Commit = { id: commitIdOf(header), ...header }
      await store.putCommit(repoId, commit)

      const refName = branchRef(branch)
      const moved = await store.casRef(repoId, refName, parent?.id, commit.id)
      if (!moved) {
        throw new VersionError('conflict', `分支 ${branch} 已被前移，请拉取后重试`)
      }

      if (!meta) {
        await store.putBranchMeta(repoId, { name: branch, protected: false, base: commit.id })
      }

      commitId = commit.id
      draftBase = commit.id
      dirty = false
      viewOnly = false
      emit({ kind: 'commit', commit })
      emit({ kind: 'ref', name: refName, target: commit.id })
      emit({ kind: 'head', head: currentHead() })

      return commit
    },

    log(query?: LogQuery): Promise<Commit[]> {
      return logCommits(store, repoId, query?.from ?? commitId, query ?? {})
    },

    async diff(from: ObjectHash, to: ObjectHash): Promise<DiffResult> {
      const [a, b] = await Promise.all([
        store.getCommit(repoId, from),
        store.getCommit(repoId, to),
      ])

      if (!a) throw new VersionError('missing-commit', `提交 ${from} 不存在`)
      if (!b) throw new VersionError('missing-commit', `提交 ${to} 不存在`)

      return diffTrees(store, repoId, a.tree, b.tree, from, to)
    },

    async listBranches(): Promise<BranchMeta[]> {
      const refs = await store.listRefs(repoId)
      const result: BranchMeta[] = []

      for (const ref of refs) {
        const name = branchNameOf(ref.name)
        if (name === undefined) continue

        const meta = await store.getBranchMeta(repoId, name)
        result.push(meta ?? { name, protected: false, base: ref.target })
      }

      return result.sort((a, b) => a.name.localeCompare(b.name))
    },

    async createBranch(name: string, from: ObjectHash): Promise<BranchMeta> {
      const trimmed = name.trim()
      if (trimmed === '' || trimmed.startsWith('refs/')) {
        throw new VersionError('invalid-input', '分支名必须是非空的短名')
      }

      const refName = branchRef(trimmed)
      if (await store.getRef(repoId, refName)) {
        throw new VersionError('conflict', `分支 ${trimmed} 已存在`)
      }
      if (!(await store.getCommit(repoId, from))) {
        throw new VersionError('missing-commit', `提交 ${from} 不存在`)
      }

      const moved = await store.casRef(repoId, refName, undefined, from)
      if (!moved) throw new VersionError('conflict', `分支 ${trimmed} 并发创建失败`)

      const meta: BranchMeta = { name: trimmed, protected: false, base: from }
      await store.putBranchMeta(repoId, meta)
      emit({ kind: 'ref', name: refName, target: from })

      return meta
    },

    async checkout(ref: string, checkoutOptions?: { force?: boolean }): Promise<VersionHead> {
      dirty = await computeDirty()
      if (dirty && !checkoutOptions?.force) {
        throw new VersionError('dirty-worktree', '工作区有未提交内容，请先提交或传 force')
      }

      const resolved = await resolveRef(ref)
      const commit =
        resolved.target === '' ? undefined : await store.getCommit(repoId, resolved.target)
      if (resolved.target !== '' && !commit) {
        throw new VersionError('missing-commit', `提交 ${resolved.target} 不存在`)
      }

      // 先持久化 HEAD 再切工作区：CAS 失败时不留下「内存已切、磁盘未切」的半状态。
      // 游离 HEAD 也要记，否则重启后会错误地回到切出前的分支。
      // 只读查看态不持久化：工作区没有跟着移动，记下来会让下次启动落在一个与草稿
      // 不同源的分支上，从而把草稿提交到错误的分支。
      if (replaceable) {
        const previousHead = await store.getRef(repoId, HEAD_REF)
        const nextHead = resolved.branch ?? `${DETACHED_PREFIX}${resolved.target}`
        const movedHead = await store.casRef(repoId, HEAD_REF, previousHead?.target, nextHead)
        if (!movedHead) {
          throw new VersionError('conflict', 'HEAD 已被并发切换，请重试检出')
        }
      }

      const tree: WorkingTree = commit ? await readTreeAt(store, repoId, commit.tree) : {}
      await config.writeWorkingTree(tree)

      branch = resolved.branch
      await settleWorkingTree(resolved.target)
      emit({ kind: 'head', head: currentHead() })

      return currentHead()
    },

    async restoreDoc(docId: string, fromCommit: ObjectHash): Promise<void> {
      if (!replaceable) {
        throw new VersionError(
          'read-only-view',
          '宿主尚不能替换工作区资产，单文档恢复不可用；恢复会写回一份不动草稿的空操作',
        )
      }

      const commit = await store.getCommit(repoId, fromCommit)
      if (!commit) throw new VersionError('missing-commit', `提交 ${fromCommit} 不存在`)

      const working = { ...(await config.readWorkingTree()) }
      const documentHash = commit.tree.docs[docId]

      if (documentHash === undefined) {
        delete working[docId]
      } else {
        working[docId] = await readDocument(store, repoId, documentHash)
      }

      await config.writeWorkingTree(working)
      dirty = await computeDirty()
      emit({ kind: 'head', head: currentHead() })
    },

    async refreshHead(): Promise<VersionHead> {
      dirty = await computeDirty()
      const head = currentHead()
      emit({ kind: 'head', head })

      return head
    },

    /** 只算不写，不检查工作区脏状态，也不移动任何 ref。 */
    async mergePreview(target: string): Promise<MergePlan> {
      const theirs = await resolveTarget(store, repoId, target)
      if (commitId === '') {
        throw new VersionError('invalid-input', '空仓库没有可合并的提交')
      }
      return computeMergePlan(store, repoId, commitId, theirs, {
        validate: config.validate,
      })
    },

    /** 预览 → 裁决 → 双亲提交；冲突或校验不通过时一个对象都不写。 */
    async merge(
      target: string,
      input?: { message?: string; resolutions?: readonly MergeResolution[] },
    ): Promise<MergeResult> {
      if (branch === undefined) {
        throw new VersionError('invalid-input', '游离 HEAD 需先建分支再合并')
      }

      if (!replaceable) {
        throw new VersionError(
          'read-only-view',
          '宿主尚不能替换工作区资产，无法落合并提交：合并结果写不回草稿，' +
            '下一次保存会把合并前的内容提交上去，等于静默撤销这次合并。可先用合并预览查看结果',
        )
      }

      dirty = await computeDirty()
      if (dirty) {
        throw new VersionError('dirty-worktree', '工作区有未提交内容，请先提交再合并')
      }

      const theirs = await resolveTarget(store, repoId, target)
      const ours = commitId
      if (ours === '') {
        throw new VersionError('invalid-input', '空仓库没有可合并的提交')
      }

      const plan = await computeMergePlan(store, repoId, ours, theirs, {
        message: input?.message,
        resolutions: input?.resolutions,
        validate: config.validate,
      })
      const relation = await mergeRelation(store, repoId, ours, theirs)

      if (relation === 'up-to-date') return { status: 'up-to-date', plan }
      if (plan.status !== 'clean') return { status: plan.status, plan }

      const refName = branchRef(branch)
      if (relation === 'fast-forward') {
        await moveRef(store, repoId, branch, ours, theirs)
        await config.writeWorkingTree(await treeOf(store, repoId, theirs))
        await settleWorkingTree(theirs)
        emit({ kind: 'ref', name: refName, target: theirs })
        emit({ kind: 'head', head: currentHead() })
        return { status: 'fast-forward', target: theirs, plan }
      }

      const commit = await writeMergeCommit(
        store,
        repoId,
        branch,
        plan,
        config.author ?? 'unknown',
        clock,
      )
      await config.writeWorkingTree(plan.tree)
      await settleWorkingTree(commit.id)
      emit({ kind: 'commit', commit })
      emit({ kind: 'ref', name: refName, target: commit.id })
      emit({ kind: 'head', head: currentHead() })

      return { status: 'merged', commit, plan }
    },

    onDidChange(listener: (event: VersionEvent) => void) {
      listeners.add(listener)

      return {
        dispose: () => {
          listeners.delete(listener)
        },
      }
    },
  }

  return service
}
