import type { Disposable } from '@lc/kernel'
import type { MaterialEntry, MaterialService, ResolvedMaterial } from '@lc/contracts'
import { moduleKey } from '@lc/contracts'
import { definePlugin } from '@lc/kernel'

/** 物料模块约定导出形状 */
interface MaterialModule {
  /** 物料名 → 组件对象 */
  components?: Record<string, unknown>
  /** 单组件物料的便捷导出 */
  default?: unknown
}

/**
 * 取出物料对应的组件。
 *
 * 先看 `components` 名字表（一个模块可以导出多个物料），取不到才用 default 兜底，
 * 让只导出单个组件的物料包不必再写一层名字表。
 */
function extractComponent(module: MaterialModule, materialName: string): unknown | undefined {
  return module.components?.[materialName] ?? module.default
}

/**
 * 物料服务插件（应用级）。
 *
 * 物料元数据来自 manifest 贡献，组件代码按需懒加载；
 * 同名物料按 priority 冲突：高优先级覆盖低优先级，同级先注册者胜出。
 */
export default definePlugin({
  name: 'service-material',
  inject: ['modules', 'contribution'],

  apply(ctx) {
    /** 生效表：贡献声明与运行时注册的合并结果，读取只走这一张表 */
    const entries = new Map<string, MaterialEntry>()

    /**
     * 运行时注册表。
     *
     * 单独保存一份，贡献变化触发 rebuild 时才能把运行时条目重新叠加回去；
     * 否则一次重建就会丢掉宿主手工注册的物料。
     */
    const manual = new Map<string, MaterialEntry>()

    /** 物料名 → 解析中的 Promise，并发渲染同一物料只会加载一次 */
    const resolved = new Map<string, Promise<ResolvedMaterial | undefined>>()
    const listeners = new Set<() => void>()
    let version = 0

    function notify(): void {
      version += 1
      for (const listener of [...listeners]) listener()
    }

    /**
     * 重建生效表。
     *
     * 同名物料按 priority 决胜：后一条只有 priority 严格更高才替换已选中的那条，
     * 因此同优先级时保留遍历中先出现的那条（贡献表按 order 升序 → priority 降序排），
     * 同一份清单每次装配结果一致。
     * 运行时 manual 只在贡献没提供同名物料时补位，即贡献优先级始终更高。
     * 重建会清空解析缓存，让已加载组件在下一次读取时按新实现重新解析。
     */
    function rebuild(): void {
      entries.clear()
      for (const item of ctx.contribution.list('materials')) {
        const value = item.value
        const existing = entries.get(value.name)
        if (existing && (existing.priority ?? 0) >= (value.priority ?? 0)) continue

        entries.set(value.name, {
          ...value,
          plugin: item.plugin,
          moduleKey: moduleKey(item.plugin, value.module),
        })
      }
      for (const [name, entry] of manual) {
        if (!entries.has(name)) entries.set(name, entry)
      }
      resolved.clear()
      notify()
    }

    // 先订阅再建表：插件是逐个装载的，晚到的物料贡献也必须触发重建
    ctx.effect(() => ctx.contribution.onDidChange(rebuild))
    rebuild()

    const service: MaterialService = {
      /**
       * 运行时注册物料（不走 manifest 贡献）。
       *
       * 只允许登记一次同名物料；贡献里已有同名条目时这里仍会收下，
       * 但 rebuild 后生效的仍是贡献那条。
       *
       * @throws manual 里已有同名物料时抛错。
       */
      register(entry: MaterialEntry): Disposable {
        if (manual.has(entry.name)) {
          throw new Error(`[material] 物料重复注册: ${entry.name}`)
        }
        manual.set(entry.name, entry)
        rebuild()

        return {
          dispose: () => {
            // 比对引用：同名的新条目已接管时，旧 Disposable 不应把它一起删掉
            if (manual.get(entry.name) !== entry) return
            manual.delete(entry.name)
            rebuild()
          },
        }
      },

      get(name) {
        return entries.get(name)
      },

      list() {
        return [...entries.values()]
      },

      get version() {
        return version
      },

      onDidChange(listener) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },

      /**
       * 解析物料组件。
       *
       * 名字未登记与模块加载失败都返回 undefined（不 reject）：渲染层要的是
       * 「拿不到就画占位」，把装配错误变成异常会让每个调用点都得写 catch。
       * 失败不留在缓存里，下一次渲染可以重试；模块缺失同样会记一条诊断。
       */
      ensure(name) {
        const cached = resolved.get(name)
        if (cached) return cached

        const entry = entries.get(name)
        if (!entry) return Promise.resolve(undefined)

        const task = ctx.modules
          .load<MaterialModule>(entry.moduleKey)
          .then((module) => {
            const component = extractComponent(module, name)
            if (!component) {
              ctx.diagnostics.report(new Error(`物料 "${name}" 未导出组件`), {
                scope: 'material',
                moduleKey: entry.moduleKey,
              })
              return undefined
            }
            return { entry, component }
          })
          .catch((error: unknown) => {
            // 加载失败不缓存，允许下次渲染重试
            resolved.delete(name)
            ctx.diagnostics.report(error, {
              scope: 'material',
              name,
              moduleKey: entry.moduleKey,
            })
            return undefined
          })

        resolved.set(name, task)
        return task
      },
    }

    ctx.effect(() => ctx.provide('material', service, { apiVersion: '1.0' }))
  },
})
