import { createRequest } from './createRequest'
import { getRequest } from './global'
import type { ApiConfigMap, ApiMethods, RequestDefaults, RequestFunction } from './types'

/**
 * 把「方法名 -> 请求配置」的映射批量转换成可直接调用的方法集合。
 *
 * 这样配置可以单独放一个文件，只描述每个接口的 url / data / 钩子；
 * 业务侧一次 createApis 就得到完整的 API 对象，调用时只需传入本次数据。
 *
 * 默认情况下所有方法复用全局共享实例（由 configureRequest 配置一次），
 * 因此拦截器、token、baseURLs 等公共能力无需在每个 API 文件重复配置。
 * 只有传入 options 时才创建独立实例（不同域名 / 不同全局错误处理的场景）。
 *
 * 每个方法的入参会作为 baseData 传给配置里的动态函数（data/params/method），
 * 这与直接调用 request(config, baseData) 的语义完全一致。
 *
 * N 从 options 的 baseURLs 键推导，并约束 configMap 各项与 defaults 中的 netType，
 * 写错域名别名会在编译期报错；复用全局实例时无静态键约束，需要约束可传入
 * configureRequest 返回的带类型 request。
 *
 * @param configMap 方法名到请求配置的映射。用 `satisfies ApiConfigMap` 声明可保留精确类型。
 * @param options 可选。传 defaults 会创建独立实例；传 request 使用指定实例；不传则复用全局实例。
 * @returns 与 configMap 同键名的方法对象，每个方法返回 Promise，失败时 reject RequestError。
 */
export function createApis<M extends ApiConfigMap<N>, N extends string = string>(
  configMap: M,
  options?: RequestDefaults<unknown, N> | RequestFunction<unknown, N>,
): ApiMethods<M> {
  // 复用已有实例时不新建 axios 实例，拦截器也不会被重复注册。
  const request =
    options === undefined
      ? getRequest<unknown, N>()
      : typeof options === 'function'
        ? options
        : createRequest<unknown, N>(options)

  const apis = {} as ApiMethods<M>

  for (const name of Object.keys(configMap) as Array<keyof M & string>) {
    // 边界断言：映射项的异构泛型无法在循环里逐项还原，精确签名由 ApiMethods 对外保证。
    apis[name] = ((baseData?: unknown) =>
      request(configMap[name], baseData)) as ApiMethods<M>[typeof name]
  }

  return apis
}
