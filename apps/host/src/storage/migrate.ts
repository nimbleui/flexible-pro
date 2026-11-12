import { STORE, getOne, putOne, replaceAll } from './idb'
import type { KvRow } from './idb'

/**
 * 一次性把旧 localStorage 数据搬进 IndexedDB。
 *
 * 老用户的资产此前落在 `lc.*` 各键里，升级后不能凭空丢掉。启动 gate 在读 IDB 之前
 * 跑一次本迁移：把每个旧键整表导进对应 object store，**全部成功后**才清除旧键——
 * 在此之前旧键一直保留作备份，任一步 IDB 写入失败就整体中止、不置完成标记，下次启动重试。
 *
 * 导入的是原始行而非收窄后的结果：收窄仍由各 store 的 hydrate 在读入时做（与 localStorage
 * 时代同一处逻辑）。索引非唯一，所以存量重复数据导入不会触发事务 abort；主键重复由 put
 * 覆盖收敛，随后 hydrate 再按 id / name 去重。单个键 JSON 损坏只跳过该键（与原来 per-store
 * 忽略坏数据一致），不拖垮整批迁移。
 */

/** 旧数组键 → 目标表；值为整份记录数组 */
const ARRAY_KEYS: readonly (readonly [string, string])[] = [
  ['lc.projects.v1', STORE.projects],
  ['lc.pages.v1', STORE.pages],
  ['lc.flows.v1', STORE.flows],
  ['lc.global-functions.v1', STORE.globalFunctions],
  ['lc.custom-components.v1', STORE.customComponents],
  ['lc.apis.v1', STORE.apiConfigs],
  ['lc.releases.v1', STORE.projectReleases],
  ['lc.release-deploy.v1', STORE.releaseDeployLog],
]

const SCOPE_KEY = 'lc.api-scope.v1'
const THEME_KEY = 'lc-theme'
const AUTH_KEY = 'lc-auth-user'

/** 迁移完成标记，存在 app_kv 里；置位后不再扫描旧键 */
const DONE_KEY = 'migration.v1.done'
/** 流程「已初始化」标记：旧 flows 键存在即置位，避免 hydrate 给删空的库再补种子图 */
const FLOWS_INIT_KEY = 'flows.initialized'

const ALL_LEGACY_KEYS: readonly string[] = [
  ...ARRAY_KEYS.map(([key]) => key),
  SCOPE_KEY,
  THEME_KEY,
  AUTH_KEY,
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** JSON 损坏按缺省处理：坏一个键只丢它，不让整批迁移失败 */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * 执行一次性迁移。幂等：已完成直接返回；无旧数据则只置完成标记。
 *
 * 环境没有 localStorage / IndexedDB 时静默跳过（隐私模式降级为纯内存态，
 * 由各 store 的 hydrate 兜底种子）。
 */
export async function migrateLegacyLocalStorage(): Promise<void> {
  if (typeof localStorage === 'undefined') return

  let done: KvRow | undefined
  try {
    done = await getOne<KvRow>(STORE.appKv, DONE_KEY)
  } catch {
    // IDB 打不开：本轮不迁移，纯内存态运行
    return
  }
  if (done?.value === true) return

  let present: string[]
  try {
    present = ALL_LEGACY_KEYS.filter((key) => localStorage.getItem(key) !== null)
  } catch (error) {
    console.error('[host] 扫描旧 localStorage 失败，跳过迁移', error)
    return
  }

  if (present.length === 0) {
    // 全新安装：无存量可搬，置标记免得每次启动都扫一遍
    await putOne<KvRow>(STORE.appKv, { key: DONE_KEY, value: true }).catch(() => {})
    return
  }

  try {
    for (const [key, store] of ARRAY_KEYS) {
      const raw = localStorage.getItem(key)
      if (raw === null) continue

      const parsed = safeParse(raw)
      if (Array.isArray(parsed)) await replaceAll(store, parsed)

      // flows 键存在即视为已初始化（空数组 / 坏数据都不再补种子，与旧读档口径一致）
      if (key === 'lc.flows.v1') {
        await putOne<KvRow>(STORE.appKv, { key: FLOWS_INIT_KEY, value: true })
      }
    }

    const scopeRaw = localStorage.getItem(SCOPE_KEY)
    if (scopeRaw !== null) {
      const parsed = safeParse(scopeRaw)
      if (isRecord(parsed)) {
        const rows = Object.entries(parsed).map(([projectId, config]) => ({
          projectId,
          ...(isRecord(config) ? config : {}),
        }))
        await replaceAll(STORE.apiScopeConfigs, rows)
      }
    }

    const theme = localStorage.getItem(THEME_KEY)
    if (theme === 'dark' || theme === 'light') {
      await putOne<KvRow>(STORE.appKv, { key: 'theme', value: theme })
    }

    const auth = localStorage.getItem(AUTH_KEY)
    if (auth !== null) {
      await putOne<KvRow>(STORE.appKv, { key: 'auth-user', value: auth })
    }

    await putOne<KvRow>(STORE.appKv, { key: DONE_KEY, value: true })
  } catch (error) {
    // IDB 写入失败：保留旧键作备份，不置完成标记，下次启动重试
    console.error('[host] 迁移 localStorage 到 IndexedDB 失败，保留原数据下次重试', error)
    return
  }

  // 到此全部导入成功，旧键才清除；清不掉也不影响已落库的数据
  for (const key of ALL_LEGACY_KEYS) {
    try {
      localStorage.removeItem(key)
    } catch {
      // 忽略：备份键残留无碍
    }
  }
}
