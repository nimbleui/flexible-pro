/**
 * Schema 迁移
 * ---
 * 文档格式升级必须是显式、可测试的迁移链，而不是渲染期的兼容分支。
 * 迁移函数保持纯：输入旧 schema，输出新 schema，不读写外部状态。
 */

import type { PageSchema } from './page'
import { compareSchemaVersion, SCHEMA_VERSION } from './version'

/** 单步迁移定义 */
export interface SchemaMigration {
  /** 起始版本（旧文档 version） */
  from: string
  /** 目标版本 */
  to: string
  /** 纯函数迁移；不得原地修改输入 */
  migrate(schema: PageSchema): PageSchema
}

/**
 * 把文档迁移到目标版本。
 *
 * @param migrations 迁移链；按 from 查找，允许乱序声明。
 * @param target 目标版本 @default SCHEMA_VERSION
 * @throws 版本高于当前支持、或缺少迁移路径时抛错（fail-closed，不静默降级）。
 */
export function migrateDocument(
  schema: PageSchema,
  migrations: readonly SchemaMigration[],
  target: string = SCHEMA_VERSION,
): PageSchema {
  if (compareSchemaVersion(schema.version, target) > 0) {
    throw new Error(`[schema] 文档版本 ${schema.version} 高于当前支持 ${target}`)
  }

  let current = schema
  const visited = new Set<string>([current.version])

  while (compareSchemaVersion(current.version, target) < 0) {
    const step = migrations.find((item) => item.from === current.version)
    if (!step) {
      throw new Error(`[schema] 缺少 ${current.version} → ${target} 的迁移路径`)
    }
    if (visited.has(step.to)) {
      throw new Error(`[schema] 迁移链存在循环: ${[...visited, step.to].join(' → ')}`)
    }

    current = { ...step.migrate(current), version: step.to }
    visited.add(step.to)
  }

  return current
}
