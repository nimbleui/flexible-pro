import type { EventDispatchRecord } from '@lc/kernel'
import { describeError } from './format'
import { EVENT_LOG_LIMIT } from './types'
import type { EventLogEntry } from './types'

/**
 * 事件日志环形缓冲。
 *
 * 内核监视器在每次监听器执行时都会回调，所以这里必须封顶：淘汰最早的一条，
 * 保证连续拖拽、框选这类高频手势不会让面板吃掉无界内存。
 */
export class EventLog {
  private items: EventLogEntry[] = []

  private seq = 0

  /**
   * @param limit 保留条数 @default EVENT_LOG_LIMIT
   */
  constructor(private readonly limit: number = EVENT_LOG_LIMIT) {}

  /**
   * 追加一条分发观测。
   *
   * 只留渲染需要的字段与错误文本，不留监听器参数与错误对象：事件参数可能带着
   * 整棵 schema 或 DOM 节点，按住不放等于制造泄漏点。
   *
   * @param record 内核监视器给出的观测记录
   * @param at 记录时间戳（毫秒）
   * @returns 落库的条目
   */
  push(record: EventDispatchRecord, at: number = Date.now()): EventLogEntry {
    this.seq += 1
    const entry: EventLogEntry = {
      seq: this.seq,
      at,
      name: record.name,
      mode: record.mode,
      duration: record.duration,
      listenerCount: record.listenerCount,
    }
    if (record.pluginId !== undefined) entry.pluginId = record.pluginId
    if (record.error !== undefined) entry.error = describeError(record.error)

    this.items.push(entry)
    if (this.items.length > this.limit) this.items.shift()
    return entry
  }

  /** 倒序快照：最新一条在最前，符合日志的阅读顺序。 */
  list(): readonly EventLogEntry[] {
    return [...this.items].reverse()
  }

  /**
   * 清空日志。
   *
   * 序号不重置：列表 key 仍需全局唯一，否则清空后立刻追加会复用旧 key。
   */
  clear(): void {
    this.items = []
  }
}
