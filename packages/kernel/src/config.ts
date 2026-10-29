import type { PluginDefinition } from './types'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * 深合并：对象递归合并，数组与标量整体替换。
 *
 * 用于「实例配置 ← intercept 覆盖」的合并。选择整体替换数组而不是拼接，
 * 因为配置里的数组通常表示一个完整策略（如 allowedHosts），拼接会产出
 * 用户无法从任何单个配置项推导出来的结果。
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T

  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    result[key] = deepMerge(result[key], value)
  }
  return result as T
}

/**
 * 解析插件配置：原始配置 → 子树 intercept 覆盖 → schema 校验与默认值。
 *
 * 顺序有意如此：intercept 属于平台/测试层的强制覆盖，必须先于默认值展开，
 * 才能保证「覆盖值不会被 schema 默认值吞掉」。无 schema 时直接返回合并结果。
 *
 * @throws schema.parse 抛出的校验错误，由 runtime 归类为配置阶段失败。
 */
export function resolveConfig(
  definition: PluginDefinition,
  rawConfig: unknown,
  intercepts: ReadonlyMap<string, object>,
): unknown {
  const intercepted = intercepts.get(definition.name)
  const merged = deepMerge(rawConfig ?? {}, intercepted)

  if (!definition.schema) return merged
  return definition.schema.parse(merged)
}
