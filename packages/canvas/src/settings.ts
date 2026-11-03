import type { Disposable } from '@lc/kernel'
import type { CanvasSetting, CanvasSettingsService } from '@lc/contracts'

/**
 * 设置项登记条目。
 *
 * 定义与当前值分开存：`set` 只替换 value 而不动 setting，因此插件持有 definition
 * 引用时不会看到 value 被就地改写，撤销注册与重复注册的判定也都只看 setting。
 */
interface SettingsEntry {
  /**
   * 设置项定义（已抹掉泛型）。
   *
   * Map 的 value 类型必须与注册时的 T 无关，T 只在 `get` / `register` 的调用点由
   * 调用方重新声明；`dispose` 比对的就是这个引用，用于识别「同 id 已被重新注册」。
   */
  setting: CanvasSetting

  /**
   * 当前值。
   *
   * 注册时初始化为 `setting.default`，之后由 `set` 覆盖为任意形状；未做 schema
   * 校验，实际类型与读取方声明的 T 是否一致由插件自己保证。
   */
  value: unknown
}

/**
 * 创建画布设置服务（单层内存实现）。
 *
 * 生产环境的合并顺序为「平台默认 → 租户锁定 → 工作区 → 用户 → 文档」；
 * 骨架阶段只保留注册与当前值，scope 字段用于后续接入持久化与策略锁定。
 */
export function createSettingsService(): CanvasSettingsService {
  /** id → 定义与当前值；value 初始化为 setting.default，之后由 set 覆盖 */
  const settings = new Map<string, SettingsEntry>()

  /** id → 订阅者；按 id 分桶，未注册的 id 也可以先订阅 */
  const listeners = new Map<string, Set<(value: unknown) => void>>()

  return {
    /**
     * 注册设置项定义。
     *
     * 注册即写入 default，读取路径不需要再回退到定义值。
     *
     * @throws 同一 id 重复注册时抛错，避免两个插件互相覆盖同名设置。
     */
    register<T>(setting: CanvasSetting<T>): Disposable {
      if (settings.has(setting.id)) {
        throw new Error(`[canvas] 设置项 id 重复: ${setting.id}`)
      }

      settings.set(setting.id, { setting: setting as CanvasSetting, value: setting.default })

      return {
        dispose: () => {
          // 比对定义引用：重复注册后旧 Disposable 不应删掉当前设置项
          if (settings.get(setting.id)?.setting !== setting) return
          settings.delete(setting.id)
          listeners.delete(setting.id)
        },
      }
    },

    /**
     * 读取当前值。
     *
     * 未注册返回 undefined；值不做 schema 校验，T 由调用方保证与注册时一致。
     */
    get<T>(id: string): T | undefined {
      return settings.get(id)?.value as T | undefined
    },

    /**
     * 写入当前值并通知订阅者。
     *
     * 与 register 相反，未注册的 id 视为装配错误直接抛错，防止插件把拼错的
     * key 写成一份永远读不到的孤儿状态。写入相同值也会照常通知（不做相等性判断），
     * 且当前不校验 setting.schema、不检查 scope / lockable。
     *
     * @throws id 未注册时抛错。
     */
    set<T>(id: string, value: T): void {
      const entry = settings.get(id)
      if (!entry) throw new Error(`[canvas] 未注册的设置项: ${id}`)
      entry.value = value

      // 先快照再回调：监听器里再次订阅或退订不应影响本轮通知
      for (const listener of [...(listeners.get(id) ?? [])]) listener(value)
    },

    /**
     * 订阅某个 id 的变化。
     *
     * id 未注册时不报错，只是永远收不到通知；dispose 只撤销当前 listener，
     * 同 id 的其它订阅者保持有效。
     */
    onDidChange(id, listener): Disposable {
      const set = listeners.get(id) ?? new Set<(value: unknown) => void>()
      set.add(listener)
      listeners.set(id, set)
      return { dispose: () => set.delete(listener) }
    },
  }
}
