import type { Disposable } from '@lc/kernel'

/**
 * 模块加载器服务。
 *
 * 插件包通过 `LoaderService.register` 把「模块 key → load 函数」登记进来，
 * 渲染器/画布宿主按贡献声明的 module 字段懒加载，避免插件之间直接 import。
 */
export interface ModuleService {
  /** 登记一个模块加载器；key 重复会抛错 */
  register(entry: ModuleEntry): Disposable
  /** 加载并缓存模块；同一 key 的并发请求共享同一个 Promise */
  load<T = unknown>(key: string): Promise<T>
  /** 预加载一组模块；失败只上报，不阻塞主流程 */
  preload(keys: readonly string[]): Promise<void>
  /** 插件卸载时清除其模块缓存（key 以 `plugin/` 为前缀） */
  evict(plugin: string): void
}

/** 模块登记项 */
export interface ModuleEntry {
  /** 全局唯一 key，推荐 `plugin/module` */
  key: string
  /** 动态加载函数；由构建期清单生成或 bootstrap 手工登记 */
  load: () => Promise<unknown>
}

/**
 * 模块 key 规范：`${插件名}/${模块声明值}`。
 *
 * 贡献里只写包内模块名（如 `dist/panel.js`），由它拼出全局 key，
 * 避免两个插件声明同一个 module 字符串时相互覆盖。
 */
export function moduleKey(plugin: string, module: string): string {
  return `${plugin}/${module}`
}
