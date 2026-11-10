let seq = 0
let persistentSeq = 0
const persistentIds = new Set<string>()

/**
 * 生成进程内唯一 id。
 *
 * 只用于运行时对象标识（插件实例、Realm、图层、历史条目）。
 * 不保证跨刷新/跨端稳定，**禁止写入持久化文档或作为文档实体的 id**：
 * 实体级合并以 id 为主键，要求「全局唯一且永不复用」，进程内自增 id 不满足，
 * 刷新后重新计数会让两侧各新建的节点被判成同一条。需要落盘时改用 `createPersistentId`。
 *
 * @param prefix 语义前缀，便于 devtools 与日志检索，如 `realm`、`plugin`。
 */
export function createId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq.toString(36)}`
}

/**
 * 生成可写入持久化文档的稳定 id：`prefix-<时间 base36><随机 base36><序号 base36>`。
 *
 * 不用 `crypto.randomUUID`：dev/preview 用局域网 IPv4 打开时页面处于非安全上下文，
 * 该 API 不可用。熵由 48bit 时间 + 48bit 随机（两次 `Math.random` 拼接）组成，
 * 模块内 `persistentSeq` 保证同进程批量创建必然前进，`persistentIds` 再挡一次重复；
 * 跨刷新/跨端的唯一性由随机部分承担，不依赖任何运行时特权 API。
 *
 * 存量 id 不做迁移：它们只是字符串，唯一性只对新建有意义。
 *
 * @param prefix 资产语义前缀，如 `page`、`flow`、`node`、`api`
 * @returns 同进程内不重复、可安全落盘的 id
 */
export function createPersistentId(prefix: string): string {
  persistentSeq += 1

  for (;;) {
    const high = Math.floor(Math.random() * 0x100000000)
    const low = Math.floor(Math.random() * 0x10000)
    const entropy = (high * 0x10000 + low).toString(36).padStart(10, '0')
    const id = `${prefix}-${Date.now().toString(36)}${entropy}${persistentSeq.toString(36)}`

    if (persistentIds.has(id)) {
      persistentSeq += 1
      continue
    }

    persistentIds.add(id)
    return id
  }
}
