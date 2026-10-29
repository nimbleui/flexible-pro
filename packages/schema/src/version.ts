/**
 * 架构版本与兼容性工具。
 *
 * PageSchema.version 与 SCHEMA_VERSION 必须一致；加载旧文档时通过
 * migrateDocument 迁移，而不是在渲染器里散落 if 判断。
 */

/** 当前驱动支持的架构版本 */
export const SCHEMA_VERSION = '1.0.0'

/**
 * 版本比较：只支持 x.y.z 数字段，返回 a 相对 b 的差值符号。
 *
 * 不引入 semver 依赖：schema 版本只用于文档格式迁移，
 * 不涉及预发布标签与范围匹配。
 */
export function compareSchemaVersion(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part) || 0)
  const right = b.split('.').map((part) => Number(part) || 0)
  const length = Math.max(left.length, right.length)

  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
