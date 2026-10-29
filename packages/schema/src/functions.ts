/**
 * 函数（Function）架构定义
 * ---
 * 允许在 PageSchema / ComponentSchema 中以纯 JSON 声明一批"表达式辅助函数"。
 * 引擎在初始化时把它们注册到表达式引擎的 FunctionRegistry，
 * 于是模板/条件/事件表达式中都可以像调用普通函数一样使用：
 *
 * ```json
 * {
 *   "functions": [
 *     {
 *       "name": "progress",
 *       "params": ["list"],
 *       "body": "list.filter(t => t.done).length + ' / ' + list.length"
 *     }
 *   ]
 * }
 * ```
 *
 * 然后节点里：`{ "text": "进度：{{ progress(todos) }}" }`
 *
 * 与 `EventChain / Flow` 的区别：
 *  - 事件链是"有副作用的动作流水"
 *  - FunctionSchema 是"纯函数"（只输入输出，不产生副作用）
 *
 * 若要复杂副作用请用 Action / Flow；此声明形式设计用于表达式内。
 */

import type { ExpressionString } from './expression'

/**
 * 声明式函数定义 —— 纯 JSON 可承载。
 * 若需要真实业务副作用（HTTP、SDK 调用等），改用宿主 `RendererOptions.functions` 通道注入。
 */
export interface FunctionSchema {
  /** 函数名（表达式中通过此名调用） */
  name: string
  /** 显示标题（编辑器展示用，可选） */
  title?: string
  /**
   * 形参名列表；调用时按位置绑定。
   * 例如 `["a", "b"]` 表示表达式内可以使用 `a`、`b`。
   */
  params?: string[]
  /**
   * 函数体表达式。
   * 支持三种写法：
   *  1. 裸表达式字符串：`"a + b"`
   *  2. 带花括号模板：`"{{ a + b }}"`
   *  3. ExpressionString 对象：`{ type: 'expression', raw: '{{ a + b }}' }`
   *
   * 内部通过 `engine.compile` 一次编译反复调用。
   */
  body: string | ExpressionString
  /** 描述说明（编辑器展示用，可选） */
  description?: string
}
