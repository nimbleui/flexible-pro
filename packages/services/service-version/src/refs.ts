/** 主干分支名；受保护，只接受合并与发布。 */
export const MAIN_BRANCH = 'main'

/**
 * 记录「当前检出到哪个分支」的 ref。
 *
 * 分支 ref 本身只存 head commit，服务重启后无从得知 HEAD 指向哪个分支。
 * target 是分支短名；游离 HEAD 时是 `detached:<commitId>`。
 * 它不是分支 ref（`branchNameOf` 返回 undefined），因此不会出现在 `listBranches`。
 */
export const HEAD_REF = 'HEAD'

/** 游离 HEAD 在 `HEAD_REF` 里的前缀。 */
export const DETACHED_PREFIX = 'detached:'

/** 分支引用前缀。 */
export const BRANCH_PREFIX = 'refs/heads/'

/** 标签引用前缀。 */
export const TAG_PREFIX = 'refs/tags/'

/**
 * 分支名 → ref 全名。
 *
 * 同时接受已带前缀的名字，避免调用方先判断再拼接产生两种写法。
 */
export function branchRef(name: string): string {
  return name.startsWith(BRANCH_PREFIX) ? name : `${BRANCH_PREFIX}${name}`
}

/** 标签名 → ref 全名。 */
export function tagRef(name: string): string {
  return name.startsWith(TAG_PREFIX) ? name : `${TAG_PREFIX}${name}`
}

/** ref 全名 → 分支名；非分支 ref 返回 undefined。 */
export function branchNameOf(ref: string): string | undefined {
  return ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : undefined
}

/** 是否为标签 ref。 */
export function isTagRef(ref: string): boolean {
  return ref.startsWith(TAG_PREFIX)
}
