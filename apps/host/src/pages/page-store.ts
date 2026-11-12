import { shallowRef } from 'vue'
import type { Disposable } from '@lc/kernel'
import type { PageSchema } from '@lc/schema'
import { stripApiBindings } from '@lc/schema'
import type { PageRecord } from './page-model'
import { createBlankPageSchema, isPageRecord, normalizePageTitle } from './page-model'
import { createBuiltinPageSeeds } from './page-seed'
import { createPersistentId } from '@lc/shared'
import { visibleInProject } from '../projects/project-model'
import { emitVersionActivity } from '../projects/version-activity'
import { STORE, getAll, replaceAll } from '../storage/idb'

/**
 * 页面存储。
 *
 * 目前没有后端，存储落在 IndexedDB（表 pages）；接服务端时只需替换本文件的读写实现，
 * 与 `workflows/flow-store.ts` 是同一种取舍。
 *
 * 与流程不同的是：页面记录带文档快照，所以这份存储是页面内容的**唯一真相**，
 * 设计器只是它的一个读取方与写回方。内存 shallowRef 由启动 gate 的 hydrate 灌入。
 */

const listeners = new Set<() => void>()

/** 生成规则收敛到 @lc/shared；路由与 EditorRealm 的 key 用的就是它 */
function createPageId(): string {
  return createPersistentId('page')
}

/**
 * JSON 往返拷贝。
 *
 * 存储里的文档不能与设计器内存中的 model.schema 共享引用：历史栈与手势预览都会继续
 * 持有同一批对象，一旦别名进存储，「保存」就退化成了实时同步，撤销也会跟着改历史。
 */
function clone(schema: PageSchema): PageSchema {
  return JSON.parse(JSON.stringify(schema)) as PageSchema
}

/** 读档收窄 + 内置种子补齐；纯逻辑，不碰浏览器 API，供 hydrate 与单测复用 */
function narrowEntries(parsed: unknown): PageRecord[] {
  if (!Array.isArray(parsed)) return createBuiltinPageSeeds()

  // id 参与路由与 Realm key，重复条目会让两个入口打开同一篇文档的不同副本
  const ids = new Set<string>()
  const existing = parsed.filter((item): item is PageRecord => {
    if (!isPageRecord(item)) return false
    if (ids.has(item.id)) return false
    ids.add(item.id)
    return true
  })

  // 内置种子补齐：已存在的内置页（含用户改过标题的）不动，缺失的（如新增的
  // form-doc，或旧版本用户还没见过的演示页）补回，保证设计器里始终能找到它们，
  // 同时不破坏「首次运行后才把内置页当普通记录」的约定——只是把「补齐」从
  // 「只在空库时」放宽到「缺失即补」，避免老用户永远看不到新加的演示页。
  const missing = createBuiltinPageSeeds().filter((seed) => !ids.has(seed.id))
  return missing.length ? [...existing, ...missing] : existing
}

function persist(entries: readonly PageRecord[]): void {
  // 隐私模式或配额不足时只丢持久化，当前会话里编辑的页面仍然可继续
  void replaceAll(STORE.pages, entries).catch((error) => {
    console.error('[host] 保存页面到 IndexedDB 失败', error)
  })
}

const state = shallowRef<readonly PageRecord[]>([])

/** 页面列表；只读约定由调用方遵守，写入必须走本模块的 create / save / rename / remove */
export const pages = state

/** 从 IndexedDB 灌入内存；读失败按空列表处理（种子由后续 narrow 补齐） */
export async function hydrate(): Promise<void> {
  try {
    state.value = narrowEntries(await getAll<PageRecord>(STORE.pages))
  } catch (error) {
    console.error('[host] 读取页面存储失败，按空列表处理', error)
    state.value = []
  }
}

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function commit(next: readonly PageRecord[]): void {
  state.value = next
  persist(next)
  notify()
}

/**
 * 让文档里的 `metadata.title` 跟记录标题一致。
 *
 * 标题只有 `renamePage` 一个写入方，同步点是这一处：不同步的话预览页取到的是
 * 文档里的旧标题，列表与预览会长期不一致。
 */
function withTitle(schema: PageSchema, title: string): PageSchema {
  return { ...schema, metadata: { ...schema.metadata, title } }
}

/**
 * 新建一个空白页面。
 *
 * 建完立刻入库并返回记录：调用方拿到 id 就跳设计器，设计器按 id 从存储里取文档。
 * 不落库的话进画布第一步就是「文档不存在」，刷新还会丢整篇内容。
 *
 * @throws 标题为空时抛错，错误文案可直接展示给用户
 */
export function createPage(title: string, projectId: string): PageRecord {
  const trimmed = normalizePageTitle(title)
  if (trimmed === '') throw new Error('[host] 页面必须命名')

  const created: PageRecord = {
    id: createPageId(),
    projectId,
    title: trimmed,
    schema: createBlankPageSchema(trimmed),
    updatedAt: new Date().toISOString(),
  }

  commit([...state.value, created])
  return created
}

/**
 * 写回设计器里的文档快照。
 *
 * 只替换文档，不动标题与归属：两者各有唯一写入方（`renamePage` 与后续的项目移动）。
 *
 * `projectId` 参与校验，是四条写入路径里唯一必须校验的一条：设计器按 id 取文档时
 * 已经用 `visibleInProject` 挡过一次，但「保存」写的是存储里的同一 id——地址栏把
 * A 项目的文档挂到 B 项目 URL 上时，画布显示的是空白文档，保存却会盖掉 A 的内容。
 * 读取端过滤、写入端不校验，就正好漏在这条自动触发的路上。
 *
 * @throws id 不存在、或不属于该项目时抛错——页面在别处被删掉时，这里要说清楚
 * 而不是静默丢弃改动
 */
export function savePageSchema(id: string, schema: PageSchema, projectId: string): PageRecord {
  const current = visibleInProject(
    state.value.find((item) => item.id === id),
    projectId,
  )
  if (!current) throw new Error(`[host] 页面不属于当前项目，无法保存: ${id}`)

  // 展开结果绝不能落盘：画布内存里的 datasources 带着装载时从项目接口拼出的地址，
  // 原样写回就等于把引用退化成副本，之后改接口定义对这个页面不再起作用
  const saved: PageRecord = {
    ...current,
    schema: withTitle(clone(stripApiBindings(schema)), current.title),
    updatedAt: new Date().toISOString(),
  }

  commit(state.value.map((item) => (item.id === id ? saved : item)))
  // 版本库是旁路：信号在写入落盘之后发出，且版本库故障不会回抛到这里
  emitVersionActivity({ kind: 'save', projectId, docId: id })
  return saved
}

/**
 * 重命名页面。
 *
 * @throws 标题为空或 id 不存在时抛错
 */
export function renamePage(id: string, title: string): PageRecord {
  const current = state.value.find((item) => item.id === id)
  if (!current) throw new Error(`[host] 页面不存在: ${id}`)

  const trimmed = normalizePageTitle(title)
  if (trimmed === '') throw new Error('[host] 页面必须命名')

  const renamed: PageRecord = {
    ...current,
    title: trimmed,
    schema: withTitle(current.schema, trimmed),
    updatedAt: new Date().toISOString(),
  }

  commit(state.value.map((item) => (item.id === id ? renamed : item)))
  return renamed
}

/** 删除页面；id 不存在时不做任何事。已打开的 Realm 不受影响，它的保存会撞到「页面不存在」 */
export function removePage(id: string): void {
  const next = state.value.filter((item) => item.id !== id)
  if (next.length === state.value.length) return
  commit(next)
}

/** 按 id 取页面记录 */
export function getPage(id: string): PageRecord | undefined {
  return state.value.find((item) => item.id === id)
}

/** 订阅页面列表变更；返回注销句柄 */
export function onPagesChange(listener: () => void): Disposable {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}
