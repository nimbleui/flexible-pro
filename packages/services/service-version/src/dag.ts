import type { Commit, LogQuery, ObjectHash, VersionStore } from '@lc/contracts'
import { VersionError } from './errors'

/**
 * 从若干起点出发可达的全部提交（含起点）。
 *
 * 缺失父提交直接抛错而不是静默截断：DAG 断了一环还继续遍历，会让 `log` 看起来
 * 历史完整，实际却少了祖先，合并基线也会算错。
 */
export async function collectCommits(
  store: VersionStore,
  repoId: string,
  starts: readonly ObjectHash[],
): Promise<Map<ObjectHash, Commit>> {
  const result = new Map<ObjectHash, Commit>()
  const queue: ObjectHash[] = [...starts]

  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined || result.has(id)) continue

    const commit = await store.getCommit(repoId, id)
    if (!commit) throw new VersionError('missing-commit', `提交 ${id} 不存在`)

    result.set(id, commit)
    queue.push(...commit.parents)
  }

  return result
}

/** 在已收集的子图里判断 ancestor 是否为 descendant 的祖先（相等也算）。 */
export function isAncestor(
  commits: ReadonlyMap<ObjectHash, Commit>,
  ancestor: ObjectHash,
  descendant: ObjectHash,
): boolean {
  if (ancestor === descendant) return commits.has(ancestor)

  const queue: ObjectHash[] = [descendant]
  const seen = new Set<ObjectHash>()

  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined || seen.has(id)) continue
    if (id === ancestor) return true

    seen.add(id)
    queue.push(...(commits.get(id)?.parents ?? []))
  }

  return false
}

/**
 * 两个提交的最近公共祖先（LCA）极大元集合。
 *
 * 多个 LCA 时不在这里合并成虚拟基线：虚拟基线是三方合并的事，且落盘会让 `log`
 * 出现用户从未创建的提交。这里只诚实返回全部极大元。
 */
export async function mergeBases(
  store: VersionStore,
  repoId: string,
  a: ObjectHash,
  b: ObjectHash,
): Promise<ObjectHash[]> {
  const left = await collectCommits(store, repoId, [a])
  const right = await collectCommits(store, repoId, [b])
  const common = [...left.keys()].filter((id) => right.has(id))

  return common
    .filter(
      (id) =>
        // id 若是另一个公共祖先的祖先，就不是极大元
        !common.some((other) => other !== id && isAncestor(left, id, other)),
    )
    .sort()
}

/** 历史查询：默认沿第一父链（线性历史），展开全部祖先时按可达顺序返回。 */
export async function logCommits(
  store: VersionStore,
  repoId: string,
  from: ObjectHash,
  query: LogQuery = {},
): Promise<Commit[]> {
  if (from === '') return []

  const limit = query.limit ?? 50
  const offset = query.offset ?? 0
  const firstParent = query.firstParent ?? true
  const ordered: Commit[] = []

  if (firstParent) {
    let current: ObjectHash | undefined = from
    const seen = new Set<ObjectHash>()

    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      const commit = await store.getCommit(repoId, current)
      if (!commit) throw new VersionError('missing-commit', `提交 ${current} 不存在`)

      ordered.push(commit)
      current = commit.parents[0]
    }
  } else {
    const queue: ObjectHash[] = [from]
    const seen = new Set<ObjectHash>()

    while (queue.length > 0) {
      const id = queue.shift()
      if (id === undefined || seen.has(id)) continue

      seen.add(id)
      const commit = await store.getCommit(repoId, id)
      if (!commit) throw new VersionError('missing-commit', `提交 ${id} 不存在`)

      ordered.push(commit)
      queue.push(...commit.parents)
    }
  }

  return ordered.slice(offset, offset + limit)
}
