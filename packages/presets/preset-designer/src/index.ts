import { definePlugin } from '@lc/kernel'
import commandPlugin from '@lc/service-command'
import expressionPlugin from '@lc/service-expression'
import keybindingPlugin from '@lc/service-keybinding'
import loaderPlugin from '@lc/service-loader'
import materialPlugin from '@lc/service-material'
import modulesPlugin from '@lc/service-modules'
import setterPlugin from '@lc/service-setter'
import workspacePlugin from '@lc/service-workspace'
import { rendererPlugin } from '@lc/vue'

/**
 * 设计器预设。
 *
 * 预设本身就是一个普通插件：宿主只安装预设，不必逐个 import 核心服务。
 * 装配顺序由各服务插件的 inject 决定；这里按「被依赖者先声明」书写，
 * 便于阅读与诊断。
 */
export default definePlugin({
  name: 'preset-designer',

  apply(ctx) {
    // 基础设施
    ctx.plugin(modulesPlugin)
    ctx.plugin(loaderPlugin)

    // 应用级能力
    ctx.plugin(materialPlugin)
    ctx.plugin(commandPlugin)
    ctx.plugin(expressionPlugin)
    ctx.plugin(setterPlugin)
    ctx.plugin(keybindingPlugin)
    ctx.plugin(rendererPlugin)

    // Realm 工厂（内部装配 document / history / selection / canvas-core）
    ctx.plugin(workspacePlugin)
  },
})
