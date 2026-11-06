import type { RequestDefaults, RestConfig } from '@lc/schema'

/**
 * 一次请求的执行选项。
 */
export interface HttpExecuteOptions {
  /** 取消信号 */
  signal?: AbortSignal
  /**
   * 调用方当前生效的请求默认值（可选）。
   *
   * 凭据来源从这里的 `auth` 读，登录接口也按这里拼域名。**为什么由调用方传**：这个服务是
   * 应用级的，活在所有文档之上，让它自己去猜「当前项目当前环境」就会把 A 项目的 token
   * 发给 B 项目的请求。
   */
  defaults?: RequestDefaults
}

/**
 * 平台 HTTP 能力（应用级，宿主提供）。
 *
 * 存在的理由是有状态 + 多调用方这两件一起成立：token 得有一份跨请求的缓存，而运行时取数与
 * 接口调试台必须走同一套「取票 → 注入 → 401 重取一次 → 重发」的规则——两处各写一遍的话，
 * 「调试通过、页面 401」就又回来了。服务名 `http` 在 `kernel/context.ts` 的
 * `RESERVED_SERVICES` 里早已占位，正是为了这一天不与第三方插件撞名。
 *
 * 语义与 `@lc/service-datasource` 的 `fetchRest` 对齐：**失败抛异常**，错误文案可直接展示；
 * 需要状态码、响应头、耗时这类完整信息（调试台）请直接用宿主的 `apis/api-request.ts`。
 */
export interface HttpService {
  /**
   * 发一次已经合并过默认值的请求。
   *
   * @param config 完整请求配置；调用方负责先跑 `mergeRequestDefaults`，这里不再拼域名
   * @param options 取消信号与当前默认值（凭据来源在其中）
   * @returns 解析后的响应体
   * @throws 非 2xx、JSON 解析失败或 fetch 本身失败时抛错
   */
  request(config: RestConfig, options?: HttpExecuteOptions): Promise<unknown>
  /**
   * 丢弃全部缓存凭据。
   *
   * 改了登录接口、换了这个环境、或用户主动退出时要调用：否则旧 token 会一直被注入，
   * 而界面上看不出请求用的还是上一个凭据。
   */
  dropTokens(): void
}
