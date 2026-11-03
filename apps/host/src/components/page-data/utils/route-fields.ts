import type { RouteFieldSchema } from '@lc/schema'
import { isValidFunctionName } from '@lc/expression'
import { FORBIDDEN_NAMES } from './data-naming'

/** 路由字段解析成功的结果；失败时由同一函数返回错误文案字符串 */
export interface ParsedRouteFields {
  /** 解析出的字段列表，顺序与输入行一致 */
  fields: RouteFieldSchema[]
}

export function formatRouteFields(fields: readonly RouteFieldSchema[] | undefined): string {
  return (fields ?? [])
    .map((field) => (field.description ? `${field.name}: ${field.description}` : field.name))
    .join('\n')
}

/**
 * 逐行解析路由字段声明（`name: 说明`）。
 *
 * 返回值复用类型本身承载错误：string 表示第一条错误文案，对象表示解析成功。
 * 这里不用异常，是因为调用方要把结果直接写进错误提示区。
 */
export function parseRouteFields(text: string, label: string): ParsedRouteFields | string {
  const fields: RouteFieldSchema[] = []
  const names = new Set<string>()

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue

    const colon = trimmed.indexOf(':')
    const name = (colon < 0 ? trimmed : trimmed.slice(0, colon)).trim()
    const description = colon < 0 ? '' : trimmed.slice(colon + 1).trim()

    if (FORBIDDEN_NAMES.has(name)) return `「${name}」是保留属性名`
    if (!isValidFunctionName(name)) return `${label}「${name}」不是合法标识符`
    if (names.has(name)) return `${label}「${name}」重复`
    names.add(name)

    fields.push({ name, ...(description === '' ? {} : { description }) })
  }

  return { fields }
}
