import { shallowRef } from 'vue'
import type { Disposable } from '@lc/kernel'
import type { RequestDefaults, RequestEnvironment } from '@lc/schema'
import type { ApiScopeConfig, EnvironmentInput } from './api-config-model'
import {
  activeEnvironment,
  createEnvironmentId,
  narrowScopeConfig,
  normalizeEnvironment,
  toRequestDefaults,
} from './api-config-model'
import { STORE, getAll, getOne, putOne, replaceAll } from '../storage/idb'
import type { KvRow } from '../storage/idb'
import { DEFAULT_PROJECT_ID } from '../projects/project-model'
import { createBuiltinEnvironmentSeed } from './api-seed'

/**
 * 项目请求环境存储。
 *
 * 目前没有后端，存储落在 IndexedDB（表 api_scope_configs，主键 projectId）；接服务端时
 * 只需替换本文件的读写实现，与 `api-store.ts`、`pages/page-store.ts` 是同一种取舍。
 *
 * 敏感值（`Authorization` 里的 token）也存这里，是明文。这是「没有后端、凭证只能在浏览器
 * 里凑」的必然结果，能做的隔离是两件事：值不落进页面文档与接口定义（所以导出、复制文档
 * 都带不走它），以及配置面板按掩码显示、避免旁人扫一眼就读到。真正的答案在后端侧——
 * 宿主接上服务端之后应由专门的 secrets 能力提供；该服务名当前未列入 `RESERVED_SERVICES`，
 * 落地时随真实提供者一并登记。
 */

const listeners = new Set<() => void>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 表行 → 内存里的「projectId → 环境集合」映射。
 *
 * 落库形态是 `{ projectId, environments, activeEnvId }` 一行一项目，主键 projectId；
 * 内存里仍按项目 id 建索引，让 `environmentsOf` 等读接口保持同步 O(1)。逐行判过
 * `projectId` 再交给 `narrowScopeConfig`：坏一行丢一行，不牵连其它项目的域名配置。
 */
function narrowRows(rows: unknown): Record<string, ApiScopeConfig> {
  if (!Array.isArray(rows)) return {}

  const result: Record<string, ApiScopeConfig> = {}
  for (const row of rows) {
    if (!isRecord(row) || typeof row.projectId !== 'string') continue
    const config = narrowScopeConfig(row)
    if (config) result[row.projectId] = config
  }

  return result
}

function persist(map: Record<string, ApiScopeConfig>): void {
  const rows = Object.entries(map).map(([projectId, config]) => ({ projectId, ...config }))
  // 写穿到 IndexedDB；失败只丢持久化，当前会话里的配置仍然可用
  void replaceAll(STORE.apiScopeConfigs, rows).catch((error) => {
    console.error('[host] 保存请求环境到 IndexedDB 失败', error)
  })
}

const state = shallowRef<Record<string, ApiScopeConfig>>({})

/**
 * 挂载前调用：把 IndexedDB 里的环境表读进内存。
 *
 * 默认项目首次运行（没有任何环境记录且未初始化）时补一套示例环境并置标记；
 * 之后删空不再补种。其它项目不播种，未配置时按 `DEFAULT_ENVIRONMENT` 兜底。
 */
export async function hydrate(): Promise<void> {
  try {
    const map = narrowRows(await getAll<unknown>(STORE.apiScopeConfigs))
    const initialized = await getOne<KvRow>(STORE.appKv, 'apiScopes.initialized')
    if (map[DEFAULT_PROJECT_ID] === undefined && initialized?.value !== true) {
      map[DEFAULT_PROJECT_ID] = createBuiltinEnvironmentSeed()
      await putOne<KvRow>(STORE.appKv, { key: 'apiScopes.initialized', value: true })
      persist(map)
    }

    state.value = map
  } catch (error) {
    console.error('[host] 读取请求环境失败，按未配置处理', error)
    state.value = {}
  }
}

/** 全部项目的环境表；只读约定由调用方遵守，写入必须走本模块 */
export const apiScopes = state

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function commit(next: Record<string, ApiScopeConfig>): void {
  state.value = next
  persist(next)
  notify()
}

function writeScope(projectId: string, config: ApiScopeConfig): void {
  commit({ ...state.value, [projectId]: config })
}

/** 某个项目的环境集合；没配置过时为空数组（生效环境由 `activeEnvironmentOf` 兜底） */
export function environmentsOf(projectId: string): readonly RequestEnvironment[] {
  return state.value[projectId]?.environments ?? []
}

/**
 * 某个项目当前生效的环境。
 *
 * 未配置时返回 `DEFAULT_ENVIRONMENT`（无前缀、无默认头）而不是 `undefined`：调用方每次都要
 * 判空的话，「没配环境」和「配了但字段为空」这两种状态就会在各处被写成两套理解。
 */
export function activeEnvironmentOf(projectId: string): RequestEnvironment {
  return activeEnvironment(state.value[projectId])
}

/**
 * 某个项目当前生效的请求默认值。
 *
 * @returns 兜底环境没有任何请求侧字段时返回 `undefined`，让取数侧走「无默认值」那条快路
 */
export function requestDefaultsOf(projectId: string): RequestDefaults | undefined {
  const defaults = toRequestDefaults(activeEnvironmentOf(projectId))
  if (defaults === undefined) return undefined

  return Object.keys(defaults).length === 0 ? undefined : defaults
}

/**
 * 新建或修改一套环境。
 *
 * 有 `id` 就整组替换该环境的可编辑字段（不是补丁：没填的默认头表示「清空」），没 `id` 就是
 * 新建并追加在末尾。新建项目的第一套环境直接成为生效环境，省掉「建完还得选一次」这一步。
 *
 * @throws 名称为空或域名写法不合法时抛错
 */
export function saveEnvironment(
  projectId: string,
  input: EnvironmentInput,
): RequestEnvironment {
  const current = state.value[projectId]
  const environment = normalizeEnvironment({
    ...input,
    id: input.id?.trim() || createEnvironmentId(),
  })

  const exists = current?.environments.some((item) => item.id === environment.id) ?? false
  const environments = exists
    ? current!.environments.map((item) => (item.id === environment.id ? environment : item))
    : [...(current?.environments ?? []), environment]

  writeScope(projectId, {
    environments,
    activeEnvId: exists ? current!.activeEnvId : (current?.activeEnvId ?? environment.id),
  })

  return environment
}

/**
 * 切换当前生效的环境。
 *
 * @throws id 不属于该项目时抛错：切到一个不存在的环境等于让所有相对地址静默退回同源路径
 */
export function setActiveEnvironment(projectId: string, envId: string): RequestEnvironment {
  const current = state.value[projectId]
  const target = current?.environments.find((item) => item.id === envId)
  if (!current || !target) throw new Error(`[host] 请求环境不存在: ${envId}`)

  writeScope(projectId, { ...current, activeEnvId: envId })

  return target
}

/**
 * 删除一套环境。
 *
 * 两道拒绝：最后一套删不掉（没有环境就没有「当前域名」，接口定义里的相对地址会无从解释），
 * 删的正是生效环境时先把它切给剩下的第一项，而不是留下一个指向已删环境的悬空指针。
 */
export function removeEnvironment(projectId: string, envId: string): void {
  const current = state.value[projectId]
  if (!current) return

  if (current.environments.length <= 1) throw new Error('[host] 至少要保留一套请求环境')

  const environments = current.environments.filter((item) => item.id !== envId)
  const activeEnvId = current.activeEnvId === envId ? environments[0]!.id : current.activeEnvId

  writeScope(projectId, { environments, activeEnvId })
}

/** 订阅环境表变更（含切换生效环境）；返回注销句柄 */
export function onApiScopeChange(listener: () => void): Disposable {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}
