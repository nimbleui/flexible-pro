import type { MaterialService, RendererService } from '@lc/contracts'
import { definePlugin } from '@lc/kernel'

/**
 * 渲染服务插件（应用级）。
 *
 * 把「物料名 → 组件」的解析从 UI 组件里抽出来：CanvasStage 与导出器
 * 都通过 `ctx.renderer` 取得组件，物料服务变化时缓存自动失效。
 */
export default definePlugin({
  name: 'service-renderer',
  inject: ['material'],
  provides: ['renderer'],

  apply(ctx) {
    const material = ctx.require<MaterialService>('material')

    /**
     * 名字 → 解析中的 Promise。
     *
     * 缓存的是 pending Promise 而不是结果，同一组件名的并发请求只会加载一次；
     * 物料注册变化时整体清空，让重新解析拿到新的实现。
     */
    const cache = new Map<string, Promise<unknown | undefined>>()

    ctx.effect(() =>
      material.onDidChange(() => {
        cache.clear()
      }),
    )

    const service: RendererService = {
      /**
       * 解析物料组件。
       *
       * 永不 reject：失败会被记进诊断并返回 undefined，调用方按「组件不可用」
       * 渲染占位即可，不需要为每个物料名写 catch。失败的结果不留在缓存里，
       * 下一次调用会重新尝试，避免一次失败把该组件永久锁死成 undefined。
       */
      resolveMaterial(name: string): Promise<unknown | undefined> {
        const cached = cache.get(name)
        if (cached) return cached

        const task = material
          .ensure(name)
          .then((resolved) => resolved?.component)
          .catch((error: unknown) => {
            cache.delete(name)
            ctx.diagnostics.report(error, { scope: 'renderer', name })
            return undefined
          })

        cache.set(name, task)
        return task
      },
    }

    ctx.effect(() => ctx.provide('renderer', service, { apiVersion: '1.0' }))
  },
})
