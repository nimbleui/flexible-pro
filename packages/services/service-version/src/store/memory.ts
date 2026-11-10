import type {
  BranchMeta,
  Commit,
  ObjectHash,
  Ref,
  VersionObject,
  VersionStore,
} from '@lc/contracts'
import { canonicalJson } from '@lc/shared'
import { VersionError, commitConflictMessage } from '../errors'

interface RepoState {
  /** 内容对象表：hash → 不可变对象 */
  objects: Map<ObjectHash, VersionObject>
  /** 提交表：commit id → 提交 */
  commits: Map<ObjectHash, Commit>
  /** 引用表：ref 全名 → Ref */
  refs: Map<string, Ref>
  /** 分支元数据表：分支名 → BranchMeta */
  branches: Map<string, BranchMeta>
}

/**
 * 内存版版本库：单测、CI 与 preview 模式的主力。
 *
 * 写入时做结构化克隆，杜绝「调用方拿着对象引用就地改，历史跟着变」；
 * 这与「对象一经写入永不修改」是同一条约束。
 */
export class MemoryVersionStore implements VersionStore {
  private readonly repos = new Map<string, RepoState>()

  private state(repoId: string): RepoState {
    let state = this.repos.get(repoId)

    if (!state) {
      state = {
        objects: new Map(),
        commits: new Map(),
        refs: new Map(),
        branches: new Map(),
      }
      this.repos.set(repoId, state)
    }

    return state
  }

  async hasObject(repoId: string, hash: ObjectHash): Promise<boolean> {
    return this.state(repoId).objects.has(hash)
  }

  async getObject(repoId: string, hash: ObjectHash): Promise<VersionObject | undefined> {
    return this.state(repoId).objects.get(hash)
  }

  async putObject(repoId: string, object: VersionObject): Promise<void> {
    const objects = this.state(repoId).objects
    const existing = objects.get(object.hash)

    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(object)) {
        throw new VersionError(
          'integrity',
          `内容地址 ${object.hash} 已存在不同内容，规范化函数可能已失效`,
        )
      }

      return
    }

    objects.set(object.hash, structuredClone(object))
  }

  async getCommit(repoId: string, id: ObjectHash): Promise<Commit | undefined> {
    return this.state(repoId).commits.get(id)
  }

  async putCommit(repoId: string, commit: Commit): Promise<void> {
    const commits = this.state(repoId).commits
    const existing = commits.get(commit.id)

    if (existing && canonicalJson(existing) !== canonicalJson(commit)) {
      throw new VersionError('integrity', commitConflictMessage(commit.id))
    }

    commits.set(commit.id, structuredClone(commit))
  }

  async getRef(repoId: string, name: string): Promise<Ref | undefined> {
    return this.state(repoId).refs.get(name)
  }

  async casRef(
    repoId: string,
    name: string,
    expected: ObjectHash | undefined,
    next: ObjectHash,
  ): Promise<Ref | undefined> {
    const refs = this.state(repoId).refs
    const current = refs.get(name)?.target

    if (current !== expected) return undefined

    const ref: Ref = {
      name,
      target: next,
      updatedAt: new Date().toISOString(),
      movedBy: 'version-service',
    }
    refs.set(name, ref)

    return ref
  }

  async listRefs(repoId: string): Promise<Ref[]> {
    return [...this.state(repoId).refs.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async scanObjectHashes(repoId: string): Promise<ObjectHash[]> {
    const state = this.state(repoId)

    return [...state.objects.keys(), ...state.commits.keys()]
  }

  async getBranchMeta(repoId: string, name: string): Promise<BranchMeta | undefined> {
    return this.state(repoId).branches.get(name)
  }

  async putBranchMeta(repoId: string, meta: BranchMeta): Promise<void> {
    this.state(repoId).branches.set(meta.name, { ...meta })
  }
}
