import { IDBFactory } from 'fake-indexeddb'
import { vi } from 'vitest'

/**
 * store 单测的 IndexedDB 脚手架。
 *
 * 各 store 改成「启动前 hydrate + 写穿 IndexedDB」后，单测需要一份内存版 IDB。
 * 沿用原来「先 stub、再 vi.resetModules() + 动态 import」的手法：每个用例装一个全新的
 * IDBFactory（数据彼此隔离），配合 resetModules 拿到干净的 idb 模块缓存（dbPromise）。
 *
 * 不是 .spec.ts，不会被 vitest 当作用例文件收集，只供同目录下的 store 测试导入。
 */

/** 装一份全新的内存 IndexedDB；在 beforeEach 里配合 vi.resetModules() 调用 */
export function stubFreshIndexedDB(): void {
  vi.stubGlobal('indexedDB', new IDBFactory())
}

/**
 * 等待 fire-and-forget 的写穿事务落定。
 *
 * persist 是 `void replaceAll(...)`，不返回 Promise；要读回持久化结果（而非内存态）
 * 必须先让待决事务跑完。fake-indexeddb 在宏任务里推进事务，让出一轮事件循环即可。
 */
export async function flushIdb(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
