import type {
  BranchMeta,
  Commit,
  ObjectHash,
  Ref,
  VersionObject,
  VersionStore,
} from '@lc/contracts'
import { canonicalJson } from '@lc/shared'
import { VersionError, commitConflictMessage } from '../errors'

const DB_VERSION = 1

/**
 * IndexedDB 版本库的选项。
 */
export interface IdbVersionStoreOptions {
  /**
   * 数据库名前缀。按 repo 分库：删掉某个库就回到「该项目未接入版本库」的状态，
   * 不需要在库内按 repoId 过滤，key 也更短。
   * @default 'lc.version'
   */
  databasePrefix?: string
}

/**
 * IndexedDB 版版本库（本地默认存储）。
 *
 * 不用 localStorage：`lc.*` 各键已在使用，而 DAG 是追加型数据，5MB 配额与同步 API
 * 都不合适。`casRef`、`putObject` 与 `putCommit` 的「读 + 校验 + 写」都放在同一个
 * readwrite 事务里，否则两个标签页并发时会各自通过校验再互相覆盖。两个内容寻址写入
 * 一律 fail-closed：同地址不同内容必须抛错，静默覆盖等于改写既有历史（I1），且会与
 * `MemoryVersionStore` 分叉——同一份数据在单测里失败、在浏览器里悄悄坏掉。
 */
export class IdbVersionStore implements VersionStore {
  private readonly databasePrefix: string
  private readonly databases = new Map<string, Promise<IDBDatabase>>()

  constructor(options: IdbVersionStoreOptions = {}) {
    this.databasePrefix = options.databasePrefix ?? 'lc.version'
  }

  private open(repoId: string): Promise<IDBDatabase> {
    const cached = this.databases.get(repoId)
    if (cached) return cached

    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`${this.databasePrefix}.${repoId}.v1`, DB_VERSION)

      request.onupgradeneeded = () => {
        const db = request.result

        if (!db.objectStoreNames.contains('objects')) {
          db.createObjectStore('objects', { keyPath: 'hash' })
        }
        if (!db.objectStoreNames.contains('commits')) {
          db.createObjectStore('commits', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('refs')) {
          db.createObjectStore('refs', { keyPath: 'name' })
        }
        if (!db.objectStoreNames.contains('branches')) {
          db.createObjectStore('branches', { keyPath: 'name' })
        }
      }

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('无法打开版本库'))
    })

    this.databases.set(repoId, promise)
    return promise
  }

  private async read<T>(
    repoId: string,
    storeName: string,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open(repoId)

    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly')
      const request = run(tx.objectStore(storeName))

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('版本库读取失败'))
      tx.onerror = () => reject(tx.error ?? new Error('版本库事务失败'))
    })
  }

  private async write(repoId: string, storeName: string, value: unknown): Promise<void> {
    const db = await this.open(repoId)

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).put(value)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('版本库写入失败'))
      tx.onabort = () => reject(tx.error ?? new Error('版本库写入被中止'))
    })
  }

  async hasObject(repoId: string, hash: ObjectHash): Promise<boolean> {
    const value = await this.getObject(repoId, hash)
    return value !== undefined
  }

  async getObject(repoId: string, hash: ObjectHash): Promise<VersionObject | undefined> {
    return this.read<VersionObject | undefined>(repoId, 'objects', (store) => store.get(hash))
  }

  async putObject(repoId: string, object: VersionObject): Promise<void> {
    const db = await this.open(repoId)

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('objects', 'readwrite')
      const store = tx.objectStore('objects')
      const existing = store.get(object.hash)
      let conflict = false

      existing.onsuccess = () => {
        const current = existing.result as VersionObject | undefined

        if (current && canonicalJson(current) !== canonicalJson(object)) {
          conflict = true
          tx.abort()
          return
        }

        if (!current) store.put(object)
      }

      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('版本库写入失败'))
      tx.onabort = () =>
        reject(
          conflict
            ? new VersionError(
                'integrity',
                `内容地址 ${object.hash} 已存在不同内容，规范化函数可能已失效`,
              )
            : (tx.error ?? new Error('版本库写入被中止')),
        )
    })
  }

  async getCommit(repoId: string, id: ObjectHash): Promise<Commit | undefined> {
    return this.read<Commit | undefined>(repoId, 'commits', (store) => store.get(id))
  }

  async putCommit(repoId: string, commit: Commit): Promise<void> {
    const db = await this.open(repoId)

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('commits', 'readwrite')
      const store = tx.objectStore('commits')
      const existing = store.get(commit.id)
      let conflict = false

      existing.onsuccess = () => {
        const current = existing.result as Commit | undefined

        if (current && canonicalJson(current) !== canonicalJson(commit)) {
          conflict = true
          tx.abort()
          return
        }

        if (!current) store.put(commit)
      }

      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('版本库写入失败'))
      tx.onabort = () =>
        reject(
          conflict
            ? new VersionError('integrity', commitConflictMessage(commit.id))
            : (tx.error ?? new Error('版本库写入被中止')),
        )
    })
  }

  async getRef(repoId: string, name: string): Promise<Ref | undefined> {
    return this.read<Ref | undefined>(repoId, 'refs', (store) => store.get(name))
  }

  async casRef(
    repoId: string,
    name: string,
    expected: ObjectHash | undefined,
    next: ObjectHash,
  ): Promise<Ref | undefined> {
    const db = await this.open(repoId)

    return new Promise<Ref | undefined>((resolve, reject) => {
      const tx = db.transaction('refs', 'readwrite')
      const store = tx.objectStore('refs')
      const current = store.get(name)
      let written: Ref | undefined

      current.onsuccess = () => {
        if ((current.result as Ref | undefined)?.target !== expected) return

        written = {
          name,
          target: next,
          updatedAt: new Date().toISOString(),
          movedBy: 'version-service',
        }
        store.put(written)
      }

      tx.oncomplete = () => resolve(written)
      tx.onerror = () => reject(tx.error ?? new Error('版本库 ref 更新失败'))
      tx.onabort = () => reject(tx.error ?? new Error('版本库 ref 更新被中止'))
    })
  }

  async listRefs(repoId: string): Promise<Ref[]> {
    const refs = await this.read<Ref[]>(repoId, 'refs', (store) => store.getAll())

    return refs.sort((a, b) => a.name.localeCompare(b.name))
  }

  async scanObjectHashes(repoId: string): Promise<ObjectHash[]> {
    const [objects, commits] = await Promise.all([
      this.read<IDBValidKey[]>(repoId, 'objects', (store) => store.getAllKeys()),
      this.read<IDBValidKey[]>(repoId, 'commits', (store) => store.getAllKeys()),
    ])

    return [...objects, ...commits].map(String)
  }

  async getBranchMeta(repoId: string, name: string): Promise<BranchMeta | undefined> {
    return this.read<BranchMeta | undefined>(repoId, 'branches', (store) => store.get(name))
  }

  async putBranchMeta(repoId: string, meta: BranchMeta): Promise<void> {
    await this.write(repoId, 'branches', meta)
  }
}
