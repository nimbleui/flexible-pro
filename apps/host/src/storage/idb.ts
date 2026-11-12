/**
 * 宿主元数据的 IndexedDB 底座。
 *
 * 取代原来散落在各 store 里的 localStorage 读写：五类设计资产、项目、请求环境、
 * 发布快照与部署留痕都落在同一个库 `lc.host.v1` 里，一张 object store 对应服务端
 * 一张表（表名 / 主键 / 索引对齐 `new-cordis-serve/src/database/sql`），未来接后端时
 * 这份本地库就是一份可直接导出的表快照。
 *
 * 与 `service-version` 的按 repo 分库不同：宿主元数据是单库多表，量级小、彼此有归属
 * 关系，放一个库里跨表读只开一次连接。文档主体（PageSchema / ComponentSchema 等）整份
 * 存为一个 value，正好对应 SQL 里 `schema jsonb` / `definition jsonb` 的单一事实源，
 * 不拆成关系行。
 *
 * 索引只对齐 SQL 里前端会用到的那几条（projectId 归属、name / material_name 检索），
 * 一律**非唯一**：唯一性仍由各 store 的 JS 逻辑保证（与 localStorage 时代一致），
 * 本地设 unique 会让存量重复数据在导入时触发事务 abort，得不偿失。
 */

const DB_NAME = 'lc.host.v1'
const DB_VERSION = 1

/** object store 名，与服务端 SQL 表名一一对应 */
export const STORE = {
  projects: 'projects',
  pages: 'pages',
  flows: 'flows',
  globalFunctions: 'global_functions',
  customComponents: 'custom_components',
  apiConfigs: 'api_configs',
  apiScopeConfigs: 'api_scope_configs',
  projectReleases: 'project_releases',
  releaseDeployLog: 'release_deploy_log',
  appKv: 'app_kv',
} as const

/** app_kv 里的一行：主题、登录标记、一次性迁移与初始化标记都存这里 */
export interface KvRow {
  /** 逻辑键，主键 */
  key: string
  /** 任意标量或小对象，读出后由调用方自行收窄 */
  value: unknown
}

/** 一条二级索引声明，keyPath 支持点路径（如 definition.meta.name） */
interface IndexSchema {
  /** 索引名，对齐 SQL 索引列 */
  name: string
  /** 取值路径 */
  keyPath: string
}

/** 一张 object store 的建表声明 */
interface StoreSchema {
  /** 表名 */
  name: string
  /** 主键路径；缺省表示用自增行外键（部署留痕这种追加日志） */
  keyPath?: string | string[]
  /** 行外键自增；仅部署留痕用 */
  autoIncrement?: boolean
  /** 二级索引；一律非唯一，见文件头说明 */
  indexes?: readonly IndexSchema[]
}

/**
 * 库结构。主键照 SQL：五类资产与项目用 text 主键 id；请求环境用 projectId；
 * 发布快照用复合键 [projectId, revision]；部署留痕无自然主键，用自增行外键。
 */
const SCHEMA: readonly StoreSchema[] = [
  { name: STORE.projects, keyPath: 'id' },
  { name: STORE.pages, keyPath: 'id', indexes: [{ name: 'projectId', keyPath: 'projectId' }] },
  { name: STORE.flows, keyPath: 'id', indexes: [{ name: 'projectId', keyPath: 'projectId' }] },
  {
    name: STORE.globalFunctions,
    keyPath: 'id',
    indexes: [
      { name: 'projectId', keyPath: 'projectId' },
      { name: 'name', keyPath: 'name' },
    ],
  },
  {
    name: STORE.customComponents,
    keyPath: 'id',
    indexes: [
      { name: 'projectId', keyPath: 'projectId' },
      { name: 'material_name', keyPath: 'definition.meta.name' },
    ],
  },
  {
    name: STORE.apiConfigs,
    keyPath: 'id',
    indexes: [{ name: 'projectId', keyPath: 'projectId' }],
  },
  { name: STORE.apiScopeConfigs, keyPath: 'projectId' },
  {
    name: STORE.projectReleases,
    keyPath: ['projectId', 'revision'],
    indexes: [{ name: 'projectId', keyPath: 'projectId' }],
  },
  {
    name: STORE.releaseDeployLog,
    autoIncrement: true,
    indexes: [{ name: 'projectId', keyPath: 'projectId' }],
  },
  { name: STORE.appKv, keyPath: 'key' },
]

let dbPromise: Promise<IDBDatabase> | undefined

/**
 * 打开（并缓存）宿主库连接。
 *
 * Promise 缓存：并发首次访问只触发一次 open，建表只在 onupgradeneeded 里做一次。
 * 环境没有 indexedDB（隐私模式禁用、非浏览器）时 reject，由各 store 的 hydrate 兜底
 * 成内存种子，与原来「读 localStorage 失败按空处理」同一降级口径。
 */
function openHostDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      for (const schema of SCHEMA) {
        const store = db.objectStoreNames.contains(schema.name)
          ? request.transaction!.objectStore(schema.name)
          : db.createObjectStore(schema.name, {
              ...(schema.keyPath === undefined ? {} : { keyPath: schema.keyPath }),
              ...(schema.autoIncrement ? { autoIncrement: true } : {}),
            })

        for (const index of schema.indexes ?? []) {
          if (!store.indexNames.contains(index.name)) {
            store.createIndex(index.name, index.keyPath, { unique: false })
          }
        }
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开宿主库'))
  })

  return dbPromise
}

/**
 * 读出一张表的全部行。
 *
 * 各 store 沿用「整表读入内存 + 内存过滤」的既有口径，所以只需 getAll；
 * 索引是为未来按项目查询与导出预留，本轮读路径不依赖它。
 */
export async function getAll<T>(storeName: string): Promise<T[]> {
  const db = await openHostDb()

  return new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).getAll()

    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error ?? new Error(`读取 ${storeName} 失败`))
    tx.onerror = () => reject(tx.error ?? new Error(`读取 ${storeName} 事务失败`))
  })
}

/**
 * 整表覆盖写。
 *
 * 各 store 的 commit 语义本就是「生成新数组整体替换」，这里在同一 readwrite 事务里
 * 先 clear 再逐行 put，保持与 localStorage 整表覆盖完全一致的语义，也避免半截写入。
 * 调用方以 fire-and-forget 方式使用（写失败只丢持久化、保留会话内存态）。
 */
export async function replaceAll<T>(storeName: string, rows: readonly T[]): Promise<void> {
  const db = await openHostDb()

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)

    store.clear()
    for (const row of rows) store.put(row)

    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error(`写入 ${storeName} 失败`))
    tx.onabort = () => reject(tx.error ?? new Error(`写入 ${storeName} 被中止`))
  })
}

/** 按主键读一行；不存在返回 undefined */
export async function getOne<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openHostDb()

  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).get(key)

    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error ?? new Error(`读取 ${storeName} 失败`))
    tx.onerror = () => reject(tx.error ?? new Error(`读取 ${storeName} 事务失败`))
  })
}

/** 按主键 upsert 一行（app_kv 与初始化标记用） */
export async function putOne<T>(storeName: string, value: T): Promise<void> {
  const db = await openHostDb()

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(value)

    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error(`写入 ${storeName} 失败`))
    tx.onabort = () => reject(tx.error ?? new Error(`写入 ${storeName} 被中止`))
  })
}
