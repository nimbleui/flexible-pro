import type { Disposable } from '@lc/kernel'

/**
 * 页面状态运行时（Realm 级）。
 * ---
 * `PageSchema.variables` 只是**声明**：名字、类型、默认值。本服务持有这些变量的
 * **当前值**，是 `state.set` / `state.reset` 动作的落点，也是表达式作用域里
 * `data.<变量名>` 的真实来源。
 *
 * 为什么必须独立于 schema：设计态渲染读的是 `defaultValue`，运行时读的是当前值，
 * 两者只在「页面刚打开」这一刻相等。把当前值写回 schema 会污染文档并进入撤销栈。
 */
export interface StateService {
  /**
   * 当前全部变量值快照。
   *
   * 只包含页面声明过的变量；每次调用返回新对象，调用方可以安全持有。
   * 变量值本身不做深拷贝——表达式引擎不允许赋值，动作只能整体替换值，
   * 因此把值当作不可变数据使用即可。
   */
  snapshot(): Readonly<Record<string, unknown>>

  /** 读单个变量；未声明的变量返回 undefined */
  get(key: string): unknown

  /**
   * 变量是否在页面中声明过。
   *
   * 写入未声明的变量对表达式是不可见的（`buildPageData` 只装配声明过的名字），
   * 因此 `state.set` 处理器必须先问一次，把「变量名写错」变成一条明确的动作失败，
   * 而不是静默写进一个谁也读不到的槽位。
   */
  has(key: string): boolean

  /**
   * 写入变量当前值。
   *
   * 写入未声明的变量会被忽略：本方法不抛错，判断责任在调用方（见 {@link has}）。
   */
  set(key: string, value: unknown): void

  /**
   * 把变量恢复到声明的 `defaultValue`。
   *
   * @param key 变量名；省略时重置页面全部变量
   */
  reset(key?: string): void

  /** 任一变量值变化时通知；订阅方自行比对 */
  onDidChange(listener: () => void): Disposable
}
