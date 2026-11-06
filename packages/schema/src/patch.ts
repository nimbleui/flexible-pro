/**
 * Schema Patch 架构定义
 * ---
 * 画布手势（拖拽/缩放/旋转/对齐）不应该直接改文档对象，而是产出一组 patch：
 * - 手势中 `record: false` 预览（不写历史、不标脏）
 * - 手势结束一次性提交（写历史、标脏）
 *
 * patch 路径采用 JSON Pointer 风格（`/nodes/n1/layout/rect/x`），
 * 只覆盖「对象属性 + 数组下标」两类操作，不实现完整 RFC 6902。
 */

import type { PageSchema } from './page'

/** patch 操作类型 */
export type SchemaPatchOp = 'add' | 'replace' | 'remove'

/**
 * 单条文档补丁。
 * 语义与 RFC 6902 的子集一致：add/replace 都需要 value，remove 忽略 value。
 */
export interface SchemaPatch {
  /** 操作类型 */
  op: SchemaPatchOp
  /** JSON Pointer 路径，如 `/nodes/n1/layout/rect` */
  path: string
  /** 新值；op 为 remove 时可省略 */
  value?: unknown
}

/** 文档补丁集合；按数组顺序依次应用 */
export type SchemaPatches = readonly SchemaPatch[]

const REMOVED = Symbol('removed')

type MutableContainer = Record<string, unknown> | unknown[]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function decodeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

function encodeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1')
}

function parsePath(path: string): string[] {
  if (path === '' || path === '/') return []
  if (!path.startsWith('/')) {
    throw new Error(`[schema] patch 路径必须以 "/" 开头: ${path}`)
  }
  return path
    .slice(1)
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(decodeSegment)
}

function applyAt(
  current: unknown,
  segments: readonly string[],
  index: number,
  patch: SchemaPatch,
): unknown | typeof REMOVED {
  if (index === segments.length) {
    return patch.op === 'remove' ? REMOVED : patch.value
  }

  const key = segments[index] as string

  if (Array.isArray(current)) {
    const array = [...current] as MutableContainer as unknown[]
    const position = Number(key)
    if (!Number.isInteger(position)) {
      throw new Error(`[schema] 数组下标非法: ${key}`)
    }
    const next = applyAt(array[position], segments, index + 1, patch)
    if (next === REMOVED) array.splice(position, 1)
    else array[position] = next
    return array
  }

  const object: Record<string, unknown> = isPlainObject(current) ? { ...current } : {}
  const next = applyAt(object[key], segments, index + 1, patch)
  if (next === REMOVED) delete object[key]
  else object[key] = next
  return object
}

/**
 * 以不可变方式应用一组 patch。
 *
 * 只克隆路径上的容器，其余分支保持引用共享，便于 Vue 侧做浅比较。
 * 路径不存在时按「父容器不存在则创建空对象」处理，与低代码场景
 * （给节点补 layout 字段）一致；数组越界会被忽略。
 *
 * @returns 应用后的新对象；原对象不会被修改。
 */
export function applyPatches<T>(target: T, patches: SchemaPatches): T {
  let result: unknown = target
  for (const patch of patches) {
    const next = applyAt(result, parsePath(patch.path), 0, patch)
    result = next === REMOVED ? undefined : next
  }
  return result as T
}

/**
 * 读取路径上的值；路径不存在返回 undefined。
 *
 * 覆盖层与属性面板只读节点几何时使用，避免各自实现一遍取值。
 */
export function getAtPath(target: unknown, path: string): unknown {
  let current: unknown = target
  for (const segment of parsePath(path)) {
    if (Array.isArray(current)) {
      const position = Number(segment)
      if (!Number.isInteger(position)) return undefined
      current = current[position]
      continue
    }
    if (!isPlainObject(current)) return undefined
    current = current[segment]
  }
  return current
}

/** 构造节点几何 patch 的便捷函数，统一路径拼装，避免各插件手写字符串。 */
export function createNodeLayoutPatch(
  nodeId: string,
  changes: Record<string, unknown>,
): SchemaPatch[] {
  return Object.entries(changes).map(([field, value]) => ({
    op: 'replace',
    path: `/nodes/${encodeSegment(nodeId)}/layout/${field}`,
    value,
  }))
}

/** 把 PageSchema 的节点 id 编码为 patch 路径片段。 */
export function nodePath(nodeId: string, suffix = ''): string {
  return `/nodes/${encodeSegment(nodeId)}${suffix ? `/${suffix}` : ''}`
}

/**
 * 文档补丁的类型收窄工具：确认 patch 的目标是节点表内路径。
 *
 * 事务提交前用它拒绝「补丁写到 components/actions」这类越权路径。
 */
export function isNodePatch(patch: SchemaPatch): boolean {
  const segments = parsePath(patch.path)
  return segments[0] === 'nodes' && segments.length >= 2
}

/** 把动作定位为 patch 路径片段。 */
export function actionPath(actionId: string, suffix = ''): string {
  return `/actions/${encodeSegment(actionId)}${suffix ? `/${suffix}` : ''}`
}

/** 把事件连接定位为 patch 路径片段。 */
export function connectionPath(connectionId: string, suffix = ''): string {
  return `/connections/${encodeSegment(connectionId)}${suffix ? `/${suffix}` : ''}`
}

/** PageSchema 的 patch 应用入口；保留泛型以便未来文档结构扩展。 */
/**
 * 整数组字段的补丁。
 *
 * 缺省时用 `add`、清空时用 `remove`、其余用 `replace`：`remove` 而不是写空数组，是为了
 * 不让存储里积出 `variables: []`、`apis: []` 这类既无语义又会干扰 diff 的键。
 * 页面数据弹框与接口绑定共用这一处判断，两边对「空数组要不要留键」的理解才不会分叉。
 *
 * @param key 文档顶层字段名，如 `datasources`
 * @param current 该字段当前的值；`undefined` 表示属性还不存在
 * @param next 要写入的完整数组
 * @returns 可直接交给文档服务的单条补丁
 */
export function arrayFieldPatch(
  key: string,
  current: readonly unknown[] | undefined,
  next: readonly unknown[],
): SchemaPatch {
  return next.length === 0
    ? { op: 'remove', path: `/${key}` }
    : current === undefined
      ? { op: 'add', path: `/${key}`, value: next }
      : { op: 'replace', path: `/${key}`, value: next }
}

export function applySchemaPatches(schema: PageSchema, patches: SchemaPatches): PageSchema {
  return applyPatches(schema, patches)
}
