import { shallowRef } from 'vue'
import type { Disposable } from '@lc/kernel'
import type { ProjectApi } from '@lc/schema'
import { resolveProjectId, visibleInProject } from '../projects/project-model'
import { pages } from '../pages/page-store'
import type { ApiEditableFields, ApiInput } from './api-model'
import { createPersistentId } from '@lc/shared'
import { isProjectApi, moveApiBefore, normalizeApiInput } from './api-model'
import { createBuiltinApiSeeds } from './api-seed'
import { STORE, getAll, getOne, putOne, replaceAll } from '../storage/idb'
import type { KvRow } from '../storage/idb'

/**
 * 项目接口存储。
 *
 * 目前没有后端，存储落在 IndexedDB（表 api_configs）；接服务端时只需替换本文件的读写实现，
 * 与 `pages/page-store.ts`、`workflows/flow-store.ts` 是同一种取舍。
 *
 * 引用关系不在这里存副本：页面文档里的 `apis` 是唯一记录点，本模块按它反查
 * 「谁在用这条接口」。自定义组件蓝图的 `datasources` 仍是自带配置，本轮不参与绑定，
 * 所以扫描只看页面，免得把一个还不存在的通道算进引用数。
 */

const listeners = new Set<() => void>()

/** 一条接口被哪些页面引用 */
export interface ApiReference {
  /** 页面文档 id，同时是设计器路由的那一段 */
  documentId: string
  /** 页面标题，用于「被 用户中心 用了」这类可直接展示的文案 */
  title: string
  /** 引用该接口的绑定名；一个页面可以把同一接口绑成两个数据源 */
  bindingIds: string[]
}

/** 生成规则收敛到 @lc/shared；页面绑定引用的就是它，改名不影响 */
function createApiId(): string {
  return createPersistentId('api')
}

/** 读档收窄；纯逻辑，不碰浏览器 API，供 hydrate 与单测复用 */
function narrowEntries(parsed: unknown): ProjectApi[] {
  if (!Array.isArray(parsed)) return []

  // id 参与页面绑定引用，重复条目会让同一个 apiId 指向两条不同定义
  const ids = new Set<string>()
  return parsed.filter((item): item is ProjectApi => {
    if (!isProjectApi(item)) return false
    if (ids.has(item.id)) return false
    ids.add(item.id)
    return true
  })
}

function persist(entries: readonly ProjectApi[]): void {
  // 隐私模式或配额不足时只丢持久化，当前会话里登记的接口仍可继续编辑
  void replaceAll(STORE.apiConfigs, entries).catch((error) => {
    console.error('[host] 保存接口到 IndexedDB 失败', error)
  })
}

const state = shallowRef<readonly ProjectApi[]>([])

/** 接口列表；只读约定由调用方遵守，写入必须走本模块的 create / update / remove */
export const apis = state

/**
 * 从 IndexedDB 灌入内存；读失败按空列表处理。
 *
 * 空库且未初始化时补一次内置种子（见 `api-seed`）并置标记：之后删空不再补种，
 * 与 `flow-store` 同一取舍。
 */
export async function hydrate(): Promise<void> {
  try {
    const rows = await getAll<ProjectApi>(STORE.apiConfigs)
    if (rows.length > 0) {
      state.value = narrowEntries(rows)
      return
    }

    const initialized = await getOne<KvRow>(STORE.appKv, 'apis.initialized')
    if (initialized?.value === true) {
      state.value = []
      return
    }

    const seed = createBuiltinApiSeeds()
    state.value = seed
    await putOne<KvRow>(STORE.appKv, { key: 'apis.initialized', value: true })
    await replaceAll(STORE.apiConfigs, seed)
  } catch (error) {
    console.error('[host] 读取接口存储失败，按空列表处理', error)
    state.value = []
  }
}

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function commit(next: readonly ProjectApi[]): void {
  state.value = next
  persist(next)
  notify()
}

function requireEditable(input: ApiInput): ApiEditableFields {
  const editable = normalizeApiInput(input)
  if (editable.name === '') throw new Error('[host] 接口必须命名')
  if (editable.path === '') throw new Error('[host] 接口必须填写请求路径')

  return editable
}

/**
 * 登记一条接口。
 *
 * 建完立刻入库并返回记录：调用方拿到 id 就能把它绑到页面上，不落库的话刷新即丢。
 * 归属项目由调用方给出（编辑器的 URL 上那一段），与 `createPage` 同一做法。
 *
 * @throws 名称或路径为空时抛错，错误文案可直接展示给用户
 */
export function createApi(input: ApiInput, projectId: string): ProjectApi {
  const editable = requireEditable(input)

  const now = new Date().toISOString()
  const created: ProjectApi = {
    id: createApiId(),
    projectId,
    createdAt: now,
    updatedAt: now,
    ...editable,
  }

  commit([...state.value, created])
  return created
}

/**
 * 修改一条接口。
 *
 * 可编辑字段整体替换，`id` / `projectId` / `createdAt` 恒从原记录带过来：归属不是表单
 * 字段，改一次定义不该把接口挪到别的项目去。已被页面引用的定义改了，所有引用它的
 * 页面在下一次装载时就用新值——这正是项目级登记存在的理由。
 *
 * @throws 名称或路径为空、id 不存在时抛错
 */
export function updateApi(id: string, input: ApiInput): ProjectApi {
  const current = state.value.find((item) => item.id === id)
  if (!current) throw new Error(`[host] 接口不存在: ${id}`)

  const editable = requireEditable(input)

  const next: ProjectApi = {
    ...current,
    ...editable,
    id: current.id,
    projectId: current.projectId,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  }

  commit(state.value.map((item) => (item.id === id ? next : item)))
  return next
}

/**
 * 拖拽排序：把一条接口移到另一条前面。
 *
 * 列表按登记顺序展示，这是唯一的排序入口；位置变化不改 `updatedAt`——排序是视图
 * 偏好，不是定义改动，不该让引用方误以为接口内容变了。任一项不存在时不写库。
 */
export function moveApi(dragId: string, targetId: string): void {
  const next = moveApiBefore(state.value, dragId, targetId)
  if (next === state.value) return

  commit(next)
}

/**
 * 反查引用某条接口的页面。
 *
 * 遍历的是内存里的页面列表（`pages` 已在读档时收窄过），所以不需要再判 schema 形状。
 * 删除拦截与列表上的引用计数都读这里，口径只有一份。
 */
export function findApiReferences(apiId: string): ApiReference[] {
  const references: ApiReference[] = []

  for (const page of pages.value) {
    const bindings = page.schema.apis?.filter((binding) => binding.apiId === apiId) ?? []
    if (bindings.length === 0) continue

    references.push({
      documentId: page.id,
      title: page.title,
      bindingIds: bindings.map((binding) => binding.id),
    })
  }

  return references
}

/**
 * 删除一条接口。
 *
 * 有页面引用时拒绝：接口内容不落进页面文档，删掉就是把这些页面的数据源变成悬空引用，
 * 而画布上看不出少了什么。与 `removeProject` 同一取舍——宁可让用户先去解绑，
 * 也不静默改动别的资产的可见行为。
 *
 * @throws 仍被页面引用时抛错；id 不存在时不做任何事
 */
export function removeApi(id: string): void {
  if (!state.value.some((item) => item.id === id)) return

  const references = findApiReferences(id)
  if (references.length > 0) {
    const where = references
      .map((item) => `「${item.title}」(${item.bindingIds.join('、')})`)
      .join('、')
    throw new Error(
      `[host] 接口仍被 ${references.length} 个页面引用：${where}，先在页面里解绑再删`,
    )
  }

  commit(state.value.filter((item) => item.id !== id))
}

/** 按 id 取接口；不按项目过滤，归属校验由 `visibleInProject` 负责 */
export function getApi(id: string): ProjectApi | undefined {
  return state.value.find((item) => item.id === id)
}

/**
 * 按 id 取接口并校验项目归属。
 *
 * 编辑器必须走这里：地址栏里的项目段与记录上的归属是两次独立输入，少一道校验就能把
 * A 项目的接口挂在 B 项目的 URL 上改，与页面编辑器同一个漏洞。
 */
export function getApiInProject(id: string, projectId: string): ProjectApi | undefined {
  return visibleInProject(getApi(id), projectId)
}

/** 某项目名下的接口，保持登记顺序 */
export function apisOfProject(projectId: string): ProjectApi[] {
  return state.value.filter((item) => resolveProjectId(item.projectId) === projectId)
}

/** 订阅接口列表变更；返回注销句柄 */
export function onApisChange(listener: () => void): Disposable {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}
