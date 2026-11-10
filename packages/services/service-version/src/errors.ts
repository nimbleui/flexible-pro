import type { ObjectHash } from '@lc/contracts'

/** 版本内核的错误分类；调用方按 code 分支，不解析错误文案。 */
export type VersionErrorCode =
  | 'missing-object'
  | 'missing-commit'
  | 'integrity'
  | 'conflict'
  | 'protected'
  | 'invalid-input'
  | 'dirty-worktree'
  | 'read-only-view'

/**
 * 带分类的版本错误。
 *
 * 用结构化 code 而不是抛裸 Error，是为了宿主能把它转成诊断面板条目；
 * 与 `CommandService.execute` 吞错并记录诊断的既有风格一致。
 */
export class VersionError extends Error {
  constructor(
    readonly code: VersionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'VersionError'
  }
}

/**
 * 提交地址冲突的统一文案，两个存储适配器必须共用这一条。
 *
 * `commitIdOf` 刻意不把 `createdAt` 纳入寻址，于是「同父、同树、同消息、同作者」的两次
 * 提交会得到同一个 id 而对象内容不同。内存版曾经抛错、IndexedDB 版曾经直接 `put` 覆盖，
 * 结果是同一份数据在单测里失败、在浏览器里悄悄改写既有提交的时间——两个适配器对同一
 * 输入必须给出同一条诊断，否则这类分叉只能靠浏览器实测才暴露。
 */
export function commitConflictMessage(id: ObjectHash): string {
  return (
    `提交 ${id} 已存在不同内容。createdAt 不参与寻址，` +
    '同父、同树、同消息、同作者的两次提交会撞同一地址；请改一下提交消息再提交'
  )
}
