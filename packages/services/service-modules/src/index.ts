import type { ModuleEntry, ModuleService } from '@lc/contracts'
import { definePlugin } from '@lc/kernel'

/**
 * 模块加载服务插件。
 *
 * 只负责「key → 动态加载」的登记、并发去重与缓存；
 * 具体模块由构建期清单或 bootstrap 登记，插件之间不直接 import。
 */
export default definePlugin({
  name: 'service-modules',

  apply(ctx) {
    /** key → 登记项；key 约定为 `插件名/模块路径`，与 moduleKey() 必须一致 */
    const loaders = new Map<string, ModuleEntry>()

    /** key → pending Promise；缓存的是任务而不是结果，并发 load 只会真正加载一次 */
    const cache = new Map<string, Promise<unknown>>()

    const service: ModuleService = {
      /**
       * 登记一个模块加载器。
       *
       * 同 key 重复登记直接抛错而不覆盖：静默替换会让已发出的 load Promise 与
       * 缓存指向两份不同实现。写入时一并清掉可能残留的旧缓存条目。
       *
       * @throws key 已存在时抛错。
       */
      register(entry) {
        if (loaders.has(entry.key)) {
          throw new Error(`[modules] 模块 key 重复: ${entry.key}`)
        }
        loaders.set(entry.key, entry)
        cache.delete(entry.key)

        return {
          dispose: () => {
            // 比对引用：同 key 已被重新登记时，旧 Disposable 不能删掉新加载器
            if (loaders.get(entry.key) !== entry) return
            loaders.delete(entry.key)
            cache.delete(entry.key)
          },
        }
      },

      /**
       * 加载模块。
       *
       * key 未登记时以 reject 结束（这是装配错误，调用方应当据此上报），
       * 而加载器自身失败不写缓存，下一次调用会重试。
       * 返回值按调用方给的 T 收窄，服务本身不知道模块导出了什么。
       */
      load<T = unknown>(key: string): Promise<T> {
        const cached = cache.get(key)
        if (cached) return cached as Promise<T>

        const entry = loaders.get(key)
        if (!entry) {
          return Promise.reject(new Error(`[modules] 未登记的模块: ${key}`))
        }

        // 失败不缓存：下次激活/渲染应允许重试
        const task = entry.load().catch((error: unknown) => {
          cache.delete(key)
          throw error
        })
        cache.set(key, task)
        return task as Promise<T>
      },

      /**
       * 批量预热模块。
       *
       * 单个 key 失败只记诊断并被吞掉，Promise 仍然正常结束：预热是优化手段，
       * 不应因为一个模块缺失就让调用它的整个流程失败。
       */
      async preload(keys) {
        await Promise.all(
          keys.map((key) =>
            service.load(key).catch((error: unknown) => {
              ctx.diagnostics.report(error, { scope: 'modules', key })
            }),
          ),
        )
      },

      /**
       * 按插件名前缀清除登记与缓存。
       *
       * 依赖 `插件名/模块路径` 这一 key 约定；改动 key 结构必须同步改这里，
       * 否则插件卸载后其模块缓存会一直留着。
       */
      evict(plugin) {
        const prefix = `${plugin}/`
        for (const key of [...loaders.keys()]) {
          if (!key.startsWith(prefix)) continue
          loaders.delete(key)
          cache.delete(key)
        }
      },
    }

    ctx.effect(() => ctx.provide('modules', service, { apiVersion: '1.0' }))
  },
})
