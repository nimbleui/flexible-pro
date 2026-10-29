let seq = 0

/**
 * 生成进程内唯一 id。
 *
 * 该 id 只用于运行时对象标识（插件实例、Realm、图层），
 * 不保证跨刷新/跨端稳定，不能写入持久化文档。
 *
 * @param prefix 语义前缀，便于 devtools 与日志检索，如 `realm`、`plugin`。
 */
export function createId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq.toString(36)}`
}
