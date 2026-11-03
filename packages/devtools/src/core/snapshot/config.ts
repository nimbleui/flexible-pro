import type { Context } from '@lc/kernel'
import type { ConfigOverride, DevtoolsScope, PluginConfigView } from '../types'
import { findRecord } from './record'

/**
 * 从根到本层逐层读 `intercepts`，收集对该插件名的配置覆盖。
 *
 * 覆盖按「后者盖前者」合并，所以必须自根向下走，展示顺序才和真实生效顺序一致。
 * 只有父插件的 Context、Realm 之外没有登记进自省范围的层也会出现在链路里，
 * 此时退回实例 id 与插件名，保证每一条覆盖都能追溯到来源。
 *
 * `patch` 直接引用内核 `intercepts` 里的对象，不深拷贝：配置面板只做只读展示，
 * 复制一份反而会让「覆盖来源是不是同一个对象」这个问题失去答案。
 */
function collectConfigOverrides(
  scopes: readonly DevtoolsScope[],
  context: Context,
  pluginName: string,
): ConfigOverride[] {
  const labelByContext = new Map<Context, DevtoolsScope>()
  for (const scope of scopes) labelByContext.set(scope.context, scope)

  const chain: Context[] = []
  for (let current: Context | null = context; current; current = current.parent) {
    chain.unshift(current)
  }

  const overrides: ConfigOverride[] = []
  for (const current of chain) {
    const patch = current.intercepts.get(pluginName)
    if (!patch) continue

    const known = labelByContext.get(current)
    overrides.push({
      scopeId: known?.id ?? current.record.id,
      label: known?.label ?? `插件 ${current.record.name}`,
      patch,
    })
  }

  return overrides
}

/**
 * 单个插件的配置视图：原始配置、解析结果与逐层覆盖来源。
 *
 * 合并只在激活时发生一次，所以「解析后的配置」对 pending / failed 实例是空的；
 * `overrides` 直接读各层 `intercepts`，能看出覆盖来自哪个 Realm 或哪个父插件。
 *
 * `raw` 与 `resolved` 引用内核记录里的同一对象，不深拷贝：配置可能是整棵数据源
 * 定义，复制既慢又会让「面板看到的和插件拿到的是不是同一个值」失去答案。
 *
 * @returns 实例不存在时返回 null
 */
export function buildConfigView(
  scopes: readonly DevtoolsScope[],
  pluginId: string,
): PluginConfigView | null {
  const located = findRecord(scopes, pluginId)
  if (!located) return null

  const { record, context } = located

  return {
    id: record.id,
    name: record.name,
    raw: record.rawConfig,
    resolved: record.config,
    overrides: collectConfigOverrides(scopes, context, record.name),
  }
}
