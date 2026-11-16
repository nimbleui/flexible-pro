import { createRequest } from './createRequest'
import type { RequestDefaults, RequestFunction } from './types'

/**
 * 全局共享的请求实例。
 *
 * 应用启动时配置一次（拦截器、token、baseURLs 等公共能力），
 * 之后所有 createApis 默认复用同一份实例，避免每次批量创建都重建 axios 实例、
 * 重复注册拦截器。仅在需要不同公共配置的场景下才创建独立实例。
 */

// 模块级单例：用 unknown/string 擦除类型，具体 B/N 在取值点由调用方重新声明。
let sharedRequest: RequestFunction<unknown, string> | undefined

/**
 * 配置全局共享实例，返回创建出的 request 以便于直接使用或测试。
 *
 * 重复调用会用新的实例覆盖旧实例；拦截器随之重新注册，不会叠加。
 * 应在应用初始化阶段、任何请求发出前调用一次。
 *
 * @param defaults 实例级默认配置，含拦截器、baseURLs、code 规则等公共配置。
 * @returns 创建出的 request 函数，与 getRequest 返回同一实例。
 */
export function configureRequest<B = unknown, N extends string = string>(
  defaults: RequestDefaults<B, N>,
): RequestFunction<B, N> {
  const request = createRequest<B, N>(defaults)

  // 类型擦除：全局槽位不绑定具体 B/N，取值时由调用方按场景重新声明。
  sharedRequest = request as RequestFunction<unknown, string>

  return request
}

/**
 * 获取全局共享的 request。未调用 configureRequest 时用空配置惰性创建，
 * 保证 createApis 在任何调用顺序下都能工作。
 *
 * @returns 全局共享的 request 函数；B/N 由调用方声明，运行时指向同一实例。
 */
export function getRequest<B = unknown, N extends string = string>(): RequestFunction<B, N> {
  if (sharedRequest === undefined) {
    sharedRequest = createRequest<unknown, string>()
  }

  return sharedRequest as RequestFunction<B, N>
}

/**
 * 清除全局实例，仅供测试隔离使用：让每个用例从干净状态开始，
 * 避免上一个用例配置的拦截器或 baseURL 泄漏到下一个用例。
 */
export function resetRequest(): void {
  sharedRequest = undefined
}
