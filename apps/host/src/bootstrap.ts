import type { CanvasRealm, LoaderService } from '@lc/contracts'
import { installContextServices } from '@lc/contracts'
import type { Context } from '@lc/kernel'
import { createApp } from '@lc/kernel'
import type { ExpressionEngine } from '@lc/schema'
import presetDesigner from '@lc/preset-designer'
import { installGlobalFunctions } from './functions/global-functions'
import { manifest as materialsBasicManifest } from '@lc/plugin-materials-basic/manifest'
import { manifest as materialsPanelManifest } from '@lc/plugin-panel-materials/manifest'
import { manifest as eventFlowPanelManifest } from '@lc/plugin-panel-eventflow/manifest'
import { manifest as outlinePanelManifest } from '@lc/plugin-panel-outline/manifest'
import { manifest as propertiesPanelManifest } from '@lc/plugin-panel-properties/manifest'

declare global {
  interface Window {
    /** 开发期调试入口；仅 DEV 下挂载 */
    __lc?: HostBootstrap
  }
}

/**
 * 平台为内置服务插件预置的保留服务授权。
 *
 * 生产环境由 loader 在签名与认证等级校验后签发；这里显式声明，
 * 保证没有控制面时也能跑通内置能力，同时保留「保留服务需要授权」的约束。
 *
 * 画布能力插件的授权不在这里：它们由远程模块自己签发（`apps/designer/src/canvas-plugins.ts`），
 * 宿主因此不认识任何画布插件 id。`service-canvas-core` 仍归宿主，
 * 因为 CanvasRealm 由宿主的 workspace 服务创建。
 */
const GRANTS: Record<string, readonly string[]> = {
  'service-modules': ['modules'],
  'service-loader': ['loader', 'contribution'],
  'service-material': ['material'],
  'service-command': ['command'],
  'service-renderer': ['renderer'],
  'service-setter': ['setter'],
  'service-workspace': ['workspace'],
  'service-document': ['document'],
  'service-history': ['history'],
  'service-selection': ['selection'],
  'service-canvas-core': ['canvas'],
}

/** 构建期内置的宿主侧插件包清单；画布能力包由远程模块登记 */
const BUILTIN_PACKAGES = [
  { manifest: materialsBasicManifest, load: () => import('@lc/plugin-materials-basic') },
  { manifest: materialsPanelManifest, load: () => import('@lc/plugin-panel-materials') },
  { manifest: outlinePanelManifest, load: () => import('@lc/plugin-panel-outline') },
  { manifest: propertiesPanelManifest, load: () => import('@lc/plugin-panel-properties') },
  { manifest: eventFlowPanelManifest, load: () => import('@lc/plugin-panel-eventflow') },
] as const

export interface HostBootstrap {
  /** 应用根上下文 */
  context: Context
  /**
   * 当前活动的画布 Realm。
   *
   * 拆分后 Realm 随路由创建、随视图释放，不再是启动期单例，所以这个字段由
   * `DesignerView` 写入与清空；只用于开发期直连画布服务排查，不参与任何运行时逻辑。
   */
  canvas?: CanvasRealm
}

/**
 * 启动主应用外壳：
 * 1. createApp → 安装 preset-designer（modules / loader / material / command / renderer / workspace）
 * 2. loader 登记宿主侧插件包的 manifest 与模块
 * 3. 注册应用级命令与快捷键
 *
 * 不创建文档 Realm：打开哪篇文档由路由决定，见 `views/DesignerView.vue`。
 */
export async function bootstrapHost(): Promise<HostBootstrap> {
  // 契约层的声明合并只有在安装访问器后才能通过 ctx.material 等属性取值
  installContextServices()

  const context = createApp({ id: 'host', grants: GRANTS })

  context.plugin(presetDesigner)
  await context.runtime.whenIdle()

  // 全局函数是应用级能力：启动时注册一次，管理页修改后由订阅重新注册
  const expression = context.require<ExpressionEngine>('expression')
  context.effect(() => installGlobalFunctions(expression))

  const loader = context.require<LoaderService>('loader')
  for (const pkg of BUILTIN_PACKAGES) loader.register(pkg)

  // 命令面板是应用级 UI：命令本身也注册在应用级，快捷键只是入口
  context.command.register({
    id: 'app.commandPalette',
    title: '打开命令面板',
    run: () => context.emit('palette:toggle'),
  })
  context.keybinding.register({
    id: 'app.commandPalette.key',
    key: 'Mod+K',
    command: 'app.commandPalette',
  })

  const result: HostBootstrap = { context }
  // 非生产模式都挂调试入口：vite dev 与 `vite build --mode development` 的预览包
  // 都需要能直连服务排查，只有 production 构建才彻底移除
  if (import.meta.env.MODE !== 'production') window.__lc = result
  return result
}
