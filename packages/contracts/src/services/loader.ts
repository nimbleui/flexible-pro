import type { Disposable } from '@lc/kernel'
import type { PluginManifest } from '../manifest'

/**
 * 构建期登记到装载器的插件包。
 *
 * 骨架阶段由 bootstrap 手工提供；生产环境由 Vite 插件扫描
 * `package.json.lowcode` 生成 `virtual:lowcode-plugins`。
 */
export interface PluginPackage {
  /** 插件清单 */
  manifest: PluginManifest
  /** 模块加载器；返回插件入口模块命名空间 */
  load: () => Promise<unknown>
}

/**
 * 装载器服务：清单扫描、贡献注册、按激活事件加载插件代码。
 *
 * 安装 ≠ 启用：`register` 只落盘清单并注册声明式贡献；
 * 只有 `ensureActivated` 命中激活事件时才执行 `import()` 与 `ctx.plugin`。
 */
export interface LoaderService {
  /** 登记插件包；返回的 Disposable 移除清单、贡献与模块登记 */
  register(pkg: PluginPackage): Disposable
  /** 当前清单列表 */
  scan(): readonly PluginManifest[]
  /** 按插件名查找插件包 */
  get(name: string): PluginPackage | undefined
  /**
   * 按激活事件激活插件。
   *
   * 命中 `activationEvents` 且声明了 `main` 的插件会被加载并挂载；
   * 无 `main` 的纯声明式插件直接跳过（模块由渲染器按贡献懒加载）。
   * `onCanvasFeature:*` 不在此处激活：画布能力必须由 CanvasHost 按文档实例化。
   */
  ensureActivated(event: string): Promise<void>
  /** 插件是否已激活 */
  isActivated(plugin: string): boolean
  /** 清单/激活状态变化通知 */
  onDidChange(listener: () => void): Disposable
}
