import type { Context, PluginRecord } from '@lc/kernel'
import type { DevtoolsScope } from '../types'

/**
 * 按实例 id 搜索命中的记录与它的解析上下文。
 *
 * 服务取值、缺依赖判定都要在 context 这一层做，而不是在持有 record 的那个插件
 * 自己的 Context 里做；pending 实例没有 Context，命中它的兄弟层即为解析层。
 */
export interface LocatedRecord {
  /** 命中的插件实例记录 */
  record: PluginRecord
  /** 记录所属的解析上下文 */
  context: Context
}

function searchChildren(
  children: ReadonlySet<PluginRecord>,
  pluginId: string,
  resolver: Context,
): LocatedRecord | null {
  for (const record of children) {
    if (record.id === pluginId) return { record, context: resolver }
    if (!record.context) continue
    const found = searchChildren(record.context.children, pluginId, record.context)
    if (found) return found
  }
  return null
}

/** 按实例 id 在全部作用域里找记录，并带回它的解析上下文。 */
export function findRecord(
  scopes: readonly DevtoolsScope[],
  pluginId: string,
): LocatedRecord | null {
  for (const scope of scopes) {
    const found = searchChildren(scope.context.children, pluginId, scope.context)
    if (found) return found
  }
  return null
}
