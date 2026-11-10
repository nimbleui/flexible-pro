import type { ContributionItem, ContributionService, ModuleService } from '@lc/contracts'
import { moduleKey } from '@lc/contracts'
import { definePlugin } from '@lc/kernel'
import type { Context, PluginDefinition } from '@lc/kernel'

/**
 * 装载贡献的 canvasFeature。
 *
 * 加载与挂载失败都只上报诊断、不中断其余能力：一个插件装不上不应该让整块画布不可用。
 * 能力按 `order` 升序挂载，顺序即插件注册层叠与交互优先级的依赖顺序。
 */
async function installCanvasFeatures(ctx: Context): Promise<void> {
  const contribution = ctx.require<ContributionService>('contribution')
  const modules = ctx.require<ModuleService>('modules')

  for (const feature of listEnabledFeatures(contribution)) {
    await mountFeature(ctx, modules, feature)
  }
}

/**
 * 参与装载的画布能力：显式关掉（`defaultEnabled === false`）的不挂载，
 * 缺省视为开启，让新增能力的插件不需要为了默认启用写额外配置。
 */
function listEnabledFeatures(
  contribution: ContributionService,
): ContributionItem<'canvasFeatures'>[] {
  return contribution
    .list('canvasFeatures')
    .filter((item) => item.value.defaultEnabled !== false)
    .sort((a, b) => (a.value.order ?? 0) - (b.value.order ?? 0))
}

/**
 * 加载并挂载单个画布能力。
 *
 * 模块解析成功但没有 default 导出属于「插件写错了」，和加载失败一样只上报诊断并跳过，
 * 两条路径都不能让 `apply` 抛出：那会让整个 CanvasRealm 装配失败。
 */
async function mountFeature(
  ctx: Context,
  modules: ModuleService,
  feature: ContributionItem<'canvasFeatures'>,
): Promise<void> {
  try {
    const module = await modules.load<{
      /** 画布能力的插件定义必须以 default 导出；缺失时视为该能力不可用，不猜命名导出 */
      default?: PluginDefinition
    }>(moduleKey(feature.plugin, feature.value.module))

    // 加载期间 CanvasRealm 可能已关闭；此时不能再往已回收的上下文挂插件
    if (ctx.signal.aborted) return

    if (!module.default) {
      ctx.diagnostics.report(new Error(`画布能力 "${feature.value.id}" 未导出插件定义`), {
        scope: 'preset-canvas',
        plugin: feature.plugin,
      })
      return
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
