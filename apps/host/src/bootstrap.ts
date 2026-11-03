import type { CanvasRealm, LoaderService, MaterialService, ModuleService } from '@lc/contracts'
import { installContextServices } from '@lc/contracts'
import type { Context } from '@lc/kernel'
import { createApp, definePlugin } from '@lc/kernel'
import type { ExpressionEngine } from '@lc/schema'
import presetDesigner from '@lc/preset-designer'
import { installCustomComponents } from './custom-components/custom-components'
import { installGlobalFunctions } from './functions/global-functions'
import { navigationService } from './navigation'
import { toastService } from './toast'
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
  'service-datasource': ['dataSource'],
  'service-state': ['pageState'],
  'service-action': ['action'],
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

/**
 * 宿主外壳的启动产物。
 *
 * 只暴露应用级 Context：文档 Realm / 画布 Realm 都由路由与视图自行创建，
 * 启动阶段不存在、也不该被外部持有。
 */
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

/** 登记宿主侧内置插件包的 manifest 与模块入口 */
function registerBuiltinPackages(loader: LoaderService): void {
  for (const pkg of BUILTIN_PACKAGES) loader.register(pkg)
}

/**
 * 挂载宿主 UI 能力：提示与路由跳转。
 *
 * 这两个服务名刻意不在 `RESERVED_SERVICES` 里（与 `expression`、`keybinding` 同类）：
 * 插件提供更好看的提示实现、或接管跳转去接自己的埋点，都是正当用法，不像 `canvas`、
 * `history` 那样承载内核语义。
 *
 * 动作执行器把它们当**可选**依赖在调用时读取，所以没有宿主的运行环境（纯逻辑测试、
 * 无 DOM 渲染）里装不上它们也只会让对应动作报错，不会让整条链跑不起来。
 */
function installHostShellUi(context: Context): void {
  context.plugin(
    definePlugin({
      name: 'host-shell-ui',
      apply(ctx) {
        ctx.effect(() => ctx.provide('toast', toastService))
        ctx.effect(() => ctx.provide('navigation', navigationService))
      },
    }),
  )
}

/**
 * 注册应用级命令与快捷键。
 *
 * 命令面板本身是应用级 UI，命令也挂在应用 Context 上：文档 Realm 关闭时
 * 快捷键仍然要能唤起它，所以不下放到画布作用域。
 */
function registerAppShellCommands(context: Context): void {
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
}

/**
 * 挂载开发期调试入口。
 *
 * 非生产模式都挂：vite dev 与 `vite build --mode development` 的预览包都需要
 * 直连服务排查，只有 production 构建才彻底移除。
 */
function exposeDebugHandle(result: HostBootstrap): void {
  if (import.meta.env.MODE !== 'production') window.__lc = result
}

/**
 * 启动主应用外壳：
 * 1. createApp → 安装 preset-designer（modules / loader / material / command / renderer / workspace）
 *    与宿主 UI 能力（toast / navigation）
 * 2. loader 登记宿主侧插件包的 manifest 与模块
 * 3. 注册应用级命令与快捷键
 *
 * 不创建文档 Realm：打开哪篇文档由路由决定，见 `views/DesignerView.vue`。
 *
 * @returns 应用级上下文；等待运行时空闲后才返回，保证内置服务已可 `require`
 */
export async function bootstrapHost(): Promise<HostBootstrap> {
  // 契约层的声明合并只有在安装访问器后才能通过 ctx.material 等属性取值
  installContextServices()

  const context = createApp({ id: 'host', grants: GRANTS })

  context.plugin(presetDesigner)
  installHostShellUi(context)
  await context.runtime.whenIdle()

  // 全局函数是应用级能力：启动时注册一次，管理页修改后由订阅重新注册
  const expression = context.require<ExpressionEngine>('expression')
  context.effect(() => installGlobalFunctions(expression))

  // 自定义组件同理：定义存在 localStorage，启动后注册成物料，管理页改动即时生效
  context.effect(() =>
    installCustomComponents(
      context.require<MaterialService>('material'),
      context.require<ModuleService>('modules'),
    ),
  )

  registerBuiltinPackages(context.require<LoaderService>('loader'))
  registerAppShellCommands(context)

  const result: HostBootstrap = { context }
  exposeDebugHandle(result)
  return result
}
