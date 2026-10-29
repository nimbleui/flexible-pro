import type { Context, ProvideOptions } from './context'

/**
 * 服务类基类。
 *
 * 继承后实例在构造时自动 `provide`，并把注销挂到当前插件的 effect 上；
 * 只适用于 class 形态的服务，函数式服务直接 `ctx.effect(() => ctx.provide(...))`。
 */
export abstract class Service {
  protected constructor(ctx: Context, name: string, options: ProvideOptions = {}) {
    ctx.effect(() => ctx.provide(name, this, { apiVersion: '1.0', ...options }))
  }
}
