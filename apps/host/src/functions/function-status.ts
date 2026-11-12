import type { GlobalFunction } from './global-functions'
import { resolveFunctionScope } from './global-functions'
import { currentReleaseOf } from '../projects/release-store'

/**
 * 函数的发布状态。
 *
 * 不落库：状态是「当前草稿」与「当前线上快照」实时对比的结果，
 * 存一份状态字段反而会在回滚 / 改动后与事实脱节。
 */
export type FunctionPublishStatus = 'published' | 'modified' | 'draft'

/**
 * 逐字段比较两份函数定义的内容是否一致。
 *
 * 不直接 JSON.stringify 整个对象：updatedAt 每次保存都变，不该影响「已发布」判定；
 * params / paramTypes 的缺省与空集合在存储口径里等价，先归一再比。
 * paramTypes 按键序 stringify 是刻意的——形参顺序变了就是内容变了。
 * 版本管理页也用它标注「快照里的这份与当前草稿是否一致」。
 */
export function functionContentMatches(a: GlobalFunction, b: GlobalFunction): boolean {
  return (
    a.name === b.name &&
    a.body === b.body &&
    (a.title ?? '') === (b.title ?? '') &&
    (a.description ?? '') === (b.description ?? '') &&
    resolveFunctionScope(a.scope) === resolveFunctionScope(b.scope) &&
    JSON.stringify(a.params ?? []) === JSON.stringify(b.params ?? []) &&
    JSON.stringify(a.paramTypes ?? {}) === JSON.stringify(b.paramTypes ?? {})
  )
}

/**
 * 派生一条函数相对当前线上版本的发布状态。
 *
 * - 项目没有线上版本，或快照里没有这条函数：`draft`（未发布）
 * - 快照里有且内容一致：`published`（已发布）
 * - 快照里有但内容已改动：`modified`（有改动，待发布）
 *
 * 按 id 而不是函数名匹配：改名后仍能认出「线上那份就是它的前身」。
 */
export function functionPublishStatus(
  fn: GlobalFunction,
  projectId: string,
): FunctionPublishStatus {
  const live = currentReleaseOf(projectId)?.assets.functions.find((item) => item.id === fn.id)
  if (!live) return 'draft'
  return functionContentMatches(fn, live) ? 'published' : 'modified'
}
