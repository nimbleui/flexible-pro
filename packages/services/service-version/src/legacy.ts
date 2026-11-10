import type { Commit, ObjectHash, PublishReceipt, VersionStore } from '@lc/contracts'
import { buildTree, commitIdOf, createSectionObject } from './object'
import { MAIN_BRANCH, branchRef, tagRef } from './refs'
import { VersionError } from './errors'
import { toWorkingTree, type VersionAssetSnapshot } from './projection'

/** 一份既有发布快照的最小形状；宿主把 `ProjectRelease` 摊成它即可。 */
export interface LegacyReleaseSnapshot {
  /** 项目内发布号，用于生成 `v{revision}` tag 与保证导入顺序 */
  revision: number
  /** 发布时间（ISO 字符串） */
  createdAt: string
  /** 五类资产的当前内容快照 */
  assets: VersionAssetSnapshot
  /** 发布时冻结的请求环境；缺省写空对象，仍会得到一个确定的 environmentHash */
  environment?: unknown
}

/** 导入既有发布的选项；缺省都是 `'migration'`，便于审计区分导入提交。 */
export interface LegacyImportOptions {
  /** @default 'migration' */
  author?: string
  /** @default 'migration' */
  publishedBy?: string
}

/** 一次导入的结果；可重跑，已存在的 tag / main 不会重复创建。 */
export interface LegacyImportResult {
  /** 本次新建的导入提交；重跑得到空数组 */
  commits: Commit[]
  /** 本次新建的 tag */
  tags: { name: string; target: ObjectHash }[]
  /** main 最终指向；已存在时不覆盖 */
  mainTarget: ObjectHash | undefined
}

/**
 * 把 `lc.releases.v1` 的既有发布导入成 commit 链。
 *
 * 只能得到「快照之间的差异」，无法还原快照内的逐次编辑：每份发布一个提交，
 * 并带 `PublishReceipt` 标记来源，UI 必须据此标注「导入的历史，粒度为发布」。
 *
 * 幂等且可重跑：对象与提交按内容地址写入；tag 用 `casRef(expected: undefined)` 的
 * create-only 语义，重复时校验目标一致即跳过，不一致才抛 integrity。main 只在不存在时
 * 初始化，绝不覆盖已有版本库。
 */
export async function importLegacyReleases(
  store: VersionStore,
  repoId: string,
  releases: readonly LegacyReleaseSnapshot[],
  options: LegacyImportOptions = {},
): Promise<LegacyImportResult> {
  const commits: Commit[] = []
  const tags: { name: string; target: ObjectHash }[] = []
  const author = options.author ?? 'migration'
  const publishedBy = options.publishedBy ?? 'migration'
  const sorted = [...releases].sort((a, b) => a.revision - b.revision)

  let parent: ObjectHash | undefined

  for (const release of sorted) {
    const { objects, commitTree } = buildTree(toWorkingTree(release.assets))
    const environmentObject = createSectionObject(
      `${repoId}:environment`,
      'environment',
      release.environment ?? {},
    )

    for (const object of [...objects, environmentObject]) {
      await store.putObject(repoId, object)
    }

    const receipt: PublishReceipt = {
      label: `v${release.revision}`,
      // 导入的历史无法重跑发布闸门；留空数组，由 UI 标注粒度而不是伪造校验结果
      issues: [],
      environmentHash: environmentObject.hash,
      publishedBy,
    }

    const header = {
      repoId,
      parents: parent ? [parent] : [],
      tree: commitTree,
      message: `导入存量 v${release.revision}`,
      author,
      createdAt: release.createdAt,
      publish: receipt,
    }
    const commit: Commit = { id: commitIdOf(header), ...header }
    await store.putCommit(repoId, commit)

    const tag = tagRef(`v${release.revision}`)
    const existingTag = await store.getRef(repoId, tag)

    if (existingTag) {
      if (existingTag.target !== commit.id) {
        throw new VersionError(
          'integrity',
          `tag ${tag} 已指向 ${existingTag.target}，与导入内容 ${commit.id} 不符`,
        )
      }
    } else {
      const moved = await store.casRef(repoId, tag, undefined, commit.id)
      if (!moved) throw new VersionError('conflict', `tag ${tag} 并发创建失败`)

      tags.push({ name: tag, target: commit.id })
      commits.push(commit)
    }

    parent = commit.id
  }

  let mainTarget: ObjectHash | undefined
  const mainRef = branchRef(MAIN_BRANCH)

  if (parent) {
    const existingMain = await store.getRef(repoId, mainRef)
    if (existingMain) {
      mainTarget = existingMain.target
    } else {
      const moved = await store.casRef(repoId, mainRef, undefined, parent)
      if (moved) mainTarget = parent
    }
  }

  return { commits, tags, mainTarget }
}
