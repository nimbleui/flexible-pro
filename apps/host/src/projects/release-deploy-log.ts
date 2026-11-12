import { projects } from './project-store'
import { STORE, getAll, replaceAll } from '../storage/idb'

/**
 * 发布 / 回滚的部署留痕。
 *
 * 快照表只记录「有哪些版本」，不记录「线上指针什么时候被谁拨过」；部署记录页签
 * 要的是后者，所以单独存一条追加式日志。与快照同一取舍：落 IndexedDB
 * （表 release_deploy_log，自增主键、无业务键），接服务端时只换读写实现。
 * 日志是展示凭据，不参与运行态，写失败只丢留痕不丢发布。
 *
 * 内存里缓存一份全量，`listDeployOf` / `appendDeploy` 保持同步；持久化写穿到 IndexedDB。
 */

/** 部署动作：publish = 发布并上线；rollback = 线上指针拨回已有快照 */
export type DeployKind = 'publish' | 'rollback'

/** 一条部署留痕 */
export interface DeployRecord {
  /** 归属项目 id */
  projectId: string
  /** 部署动作 */
  kind: DeployKind
  /** 目标发布号 */
  revision: number
  /** 发生时间（ISO 字符串） */
  at: string
  /** 操作人，取本地登录标记 */
  by: string
}

/** 每个项目保留的留痕条数；日志只供展示，不留全量 */
const DEPLOY_RETENTION = 30

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 读档收窄：形状坏的条目直接丢，不让手改存储把页签渲染炸掉 */
function narrowRecord(value: unknown): DeployRecord | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.projectId !== 'string' || value.projectId === '') return undefined
  if (value.kind !== 'publish' && value.kind !== 'rollback') return undefined
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision)) return undefined
  if (value.revision < 1) return undefined
  if (typeof value.at !== 'string') return undefined
  if (typeof value.by !== 'string' || value.by === '') return undefined

  return {
    projectId: value.projectId,
    kind: value.kind,
    revision: value.revision,
    at: value.at,
    by: value.by,
  }
}

/**
 * 表行 → 留痕列表。
 *
 * 项目已删除的留痕没有可达入口，跟快照读档同一口径收掉；依赖 `projects.value`，
 * 因此必须在项目 store hydrate 之后再调用。
 */
function narrowEntries(rows: unknown): DeployRecord[] {
  if (!Array.isArray(rows)) return []

  const entries: DeployRecord[] = []
  for (const item of rows) {
    const record = narrowRecord(item)
    if (!record) continue
    if (!projects.value.some((project) => project.id === record.projectId)) continue
    entries.push(record)
  }

  return entries
}

/** 全量留痕的内存副本；写入顺序即数组顺序，读接口据此保持同步 */
let cache: DeployRecord[] = []

function persist(entries: readonly DeployRecord[]): void {
  void replaceAll(STORE.releaseDeployLog, entries).catch((error) => {
    console.error('[host] 保存部署留痕到 IndexedDB 失败', error)
  })
}

/** 挂载前调用：把 IndexedDB 里的留痕读进内存；必须在项目 store hydrate 之后 */
export async function hydrate(): Promise<void> {
  try {
    cache = narrowEntries(await getAll<unknown>(STORE.releaseDeployLog))
  } catch (error) {
    console.error('[host] 读取部署留痕失败，按空列表处理', error)
    cache = []
  }
}

/** 某个项目的部署留痕，按时间倒序；同一毫秒内按写入顺序倒序 */
export function listDeployOf(projectId: string): DeployRecord[] {
  return cache.filter((record) => record.projectId === projectId).reverse()
}

/** 追加一条留痕并按项目剪枝；调用方在发布 / 回滚落盘后调用 */
export function appendDeploy(record: DeployRecord): void {
  const entries = [...cache, record]
  const kept: DeployRecord[] = []
  const counts = new Map<string, number>()

  // 从新到旧遍历，每个项目只收前 DEPLOY_RETENTION 条，再翻回写入顺序
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    const count = counts.get(entry.projectId) ?? 0
    if (count >= DEPLOY_RETENTION) continue
    counts.set(entry.projectId, count + 1)
    kept.push(entry)
  }

  cache = kept.reverse()
  persist(cache)
}
