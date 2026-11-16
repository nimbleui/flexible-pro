import type { FunTypeMixin } from './types'

// 点路径允许用户提供，必须挡住原型链，避免读到 Object.prototype 上的成员。
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * 解析「静态值或基于 baseData 的动态函数」配置。
 *
 * 因为 X 本身也可能是函数类型，这里约定函数值一律视为动态计算函数；
 * 该断言只发生在这个边界，用于让 TS 在无法收窄的泛型联合上取到函数分支。
 *
 * @param value 静态值或动态函数配置；未配置时为 undefined。
 * @param baseData 传给动态函数的本次调用数据。
 * @returns 解析后的值；未配置时返回 undefined。
 */
export function resolveMixin<X, B>(
  value: FunTypeMixin<X, B> | undefined,
  baseData: B | undefined,
): X | undefined {
  if (value === undefined) return undefined

  if (typeof value === 'function') {
    return (value as (input: B | undefined) => X)(baseData)
  }

  return value
}

/**
 * 安全读取点语法路径。数组下标按对象属性读取即可；任一段缺失、值为原始类型或
 * 命中原型链关键字时返回 undefined，不抛异常，避免后端字段缺失打断整个请求。
 *
 * @param source 待取值的数据源，通常是响应体。
 * @param path 点语法路径，如 `data.list.0.id`。
 * @returns 路径对应的值；路径无效或命中原型链关键字时返回 undefined。
 */
export function getValueByPath(source: unknown, path: string): unknown {
  let current: unknown = source

  for (const segment of path.split('.')) {
    if (segment === '' || BLOCKED_PATH_SEGMENTS.has(segment)) return undefined

    if (current === null || typeof current !== 'object') return undefined

    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

/**
 * 把 `string | string[]` 归一化成可比较的字符串数组。
 * 后端 code 可能是数字，统一在调用侧用 String 转换后再比较。
 *
 * @param value 单个 code 或 code 数组；未配置时为 undefined。
 * @returns 字符串数组；未配置时返回 undefined。
 */
export function toCodeList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.map(String) : [String(value)]
}
