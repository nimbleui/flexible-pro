import type { ContributionItem, ContributionService, ModuleService } from '@lc/contracts'
import { moduleKey } from '@lc/contracts'
import { definePlugin } from '@lc/kernel'
import type { Context, PluginDefinition } from '@lc/kernel'

/**
 * 装载贡献的 canvasFeature。
 *
 * 加载与挂载失败都只上报诊断、不中断其余能力：一个插件装不上不应该让整块画布不可用。
 */
async function installCanvasFeatures(ctx: Context): Promise<void> {
  const contribution = ctx.require<ContributionService>('contribution')
  const modules = ctx.require<ModuleService>('modules')

  const features: ContributionItem<'canvasFeatures'>[] = contribution
    .list('canvasFeatures')
    .filter((item) => item.value.defaultEnabled !== false)
    .sort((a, b) => (a.value.order ?? 0) - (b.value.order ?? 0))

  for (const feature of features) {
    try {
      const module = await modules.load<{ default?: PluginDefinition }>(
        moduleKey(feature.plugin, feature.value.module),
      )
      if (!module.default) {
        ctx.diagnostics.report(new Error(`画布能力 "${feature.value.id}" 未导出插件定义`), {
          scope: 'preset-canvas',
          plugin: feature.plugin,
        })
        continue
      }

      // 每个 CanvasRealm 独立实例；实例注册关系挂在画布上，文档关闭自动卸载
      ctx.plugin(module.default, feature.value.config)
    } catch (error) {
      ctx.diagnostics.report(error, {
        scope: 'preset-canvas',
        plugin: feature.plugin,
        feature: feature.value.id,
      })
    }
  }
}

/**
 * 页面画布预设。
 *
 * 不硬编码任何画布插件：从 manifest 贡献读取 `canvasFeatures`，
 * 按 order 排序后逐个加载模块并挂载到当前 CanvasRealm。
 *
 * 新增画布能力 = 新包 + 新 manifest，无需改宿主与预设。
 */
export default definePlugin({
  name: 'preset-canvas',
  inject: ['canvas', 'contribution', 'modules'],

  apply(ctx) {
    return installCanvasFeatures(ctx)
  },
})
