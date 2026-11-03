/**
 * 轻提示服务（应用级，由宿主提供）。
 * ---
 * `ui.toast` 动作的落点。刻意只留一个方法：提示是「说完就走」的单向输出，
 * 不需要返回值、不需要句柄、不参与状态。需要用户确认的场景是对话框，
 * 那是另一个动作类型，不要往这里加。
 *
 * 声明为**应用级可选**服务：它依赖真实 DOM 与宿主样式，无 UI 的运行环境
 * （纯逻辑测试、服务端预渲染）不会提供。`ui.toast` 处理器在拿不到服务时
 * 报一条明确失败，而不是静默吞掉。
 */

/** 提示级别；与 `ui.toast` 动作的 `level` 配置项一一对应 */
export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

export interface ToastService {
  /**
   * 弹出一条提示。
   *
   * @param message 提示文本；已由执行器完成插值，实现方不需要再解析表达式
   * @param level 级别，缺省为 `'info'`
   */
  show(message: string, level?: ToastLevel): void
}
