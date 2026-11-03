import { isValidFunctionName } from '@lc/expression'

/** 表单编辑态：新建、列表下标、或已重置 */
export type EditingKey = 'new' | number | null

/** 变量、数据源、路由字段最终都挂在同一个 `data` 命名空间下，这些名字会污染原型链 */
export const FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
])

/** 表单当前是在新建而不是编辑；editing 为 null（表单已重置）同样按新建处理 */
export function isCreating(editing: EditingKey): boolean {
  return editing === 'new' || editing === null
}

/**
 * 列表的新增 / 按位替换。
 *
 * 编辑态记录的是列表下标而不是 id：数据源允许在表单里改名，用旧 id 定位会找不到
 * 原条目，按下标写回才能保住它的位置与其余条目。
 */
export function upsertAt<T>(list: readonly T[], editing: EditingKey, item: T): T[] {
  return isCreating(editing)
    ? [...list, item]
    : list.map((entry, index) => (index === editing ? item : entry))
}

/** 名字校验；返回错误文案，空串表示通过 */
export function validateDataName(name: string, taken: Set<string>, label: string): string {
  if (name === '') return `请填写${label}`
  if (FORBIDDEN_NAMES.has(name)) return `「${name}」是保留属性名`
  if (!isValidFunctionName(name)) return `${label}需以文字、下划线或 $ 开头，且不能是字面量`
  if (taken.has(name)) return `「${name}」与已有变量或数据源重名`
  return ''
}

/** 默认值展示文本 */
export function formatValue(value: unknown): string {
  if (value === undefined) return ''
  // 字符串也保留引号：否则 "true" 这类默认值再次保存时会被解析成布尔值
  return JSON.stringify(value, null, 2) ?? String(value)
}
