/**
 * 路由跳转服务（应用级，由宿主提供）。
 * ---
 * `navigation.go` 动作的落点。平台自身不持有路由实例——vue-router 装在宿主应用里，
 * 因此这是一层由宿主注入的适配：同一个动作在预览页与真实业务页里跳到各自的路由。
 *
 * 声明为**应用级可选**服务，理由与 `toast` 相同：无宿主路由的环境不提供，
 * 处理器拿不到时报明确失败。
 */
export interface NavigationService {
  /**
   * 跳转到目标路径。
   *
   * @param to 目标路径；已由执行器完成插值
   * @param options.replace 为 true 时替换当前历史记录而不是压栈，缺省 false
   */
  go(to: string, options?: { replace?: boolean }): void
}
