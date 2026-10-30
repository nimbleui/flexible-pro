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
 * 若需要真实业务副作用（HTTP、SDK 调用等），由宿主把函数放进求值作用域，
 * 不要写进 schema。
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
   *
   * 作用域约束：函数体只能看到**形参、已注册的自定义函数与内置函数**，
   * 看不到调用处的局部变量。这是刻意选择的扁平作用域而非词法作用域 ——
   * 「纯函数、只输入输出」的契约一旦允许捕获调用方上下文，同一函数在
   * 不同节点上的结果就可能不同，声明式函数也就失去了可被编辑器独立校验的意义。
   */
  body: string | ExpressionString
  /** 描述说明（编辑器展示用，可选） */
  description?: string
}

/**
 * 自定义函数的注册层级，从低到高固定为 `material` → `page`。
 *
 * - `material`：`ComponentSchema.functions`，随物料实例注册与注销
 * - `page`：`PageSchema.functions`，随文档切换注册与注销
 *
 * 没有 `host` 层：宿主注入的真实 JS 函数（HTTP 封装、格式化、SDK 桥接）
 * 直接作为求值作用域里的函数值出现，表达式按名字调用即可，不需要注册表条目。
 * 它们本就与物料代码同级受信，加一层注册 API 只会多出一个没人维护的名字空间。
 *
 * 覆盖规则：同层后注册覆盖先注册，高层覆盖低层；
 * **内置函数不可被覆盖**，与之重名的注册会被拒绝并上报诊断 ——
 * 否则单个页面就能改变 `round`、`isEmpty` 等全局语义，
 * 而这类改动在设计器里对其他人是不可见的。
 */
export type FunctionScopeLevel = 'material' | 'page'

/** 一次注册的句柄；dispose 幂等，重复调用不会撤销后续注册 */
export interface FunctionRegistration {
  /** 撤销本次注册涉及的全部函数，恢复到本次注册之前的解析结果 */
  dispose(): void
}

/**
 * 自定义函数注册表。
 *
 * 保持为「四层查找表 + 注销句柄」，不做成插件扩展点：
 * 内置函数由引擎自身提供，宿主/物料/页面三层由注册方按层级声明，
 * 没有第五种来源，因此不提供 `registerProvider` 一类的通用机制。
 */
export interface FunctionRegistry {
  /**
   * 注册单个声明式函数。
   *
   * 注册即编译：函数体语法非法时不会进入查找链，而是上报诊断并返回空句柄，
   * 保证「注册失败」不影响其余函数与页面渲染。
   *
   * @param fn - 声明式函数定义
   * @param level - 注册层级 @default 'page'
   * @returns 注销句柄
   */
  register(fn: FunctionSchema, level?: FunctionScopeLevel): FunctionRegistration

  /**
   * 批量注册，返回一个统一注销的句柄。
   * 用于页面级函数：文档切换时只需 dispose 一次，无需记住每个函数的层级。
   *
   * @param fns - 声明式函数列表
   * @param level - 注册层级 @default 'page'
   * @returns 注销句柄
   */
  registerAll(fns: readonly FunctionSchema[], level?: FunctionScopeLevel): FunctionRegistration

  /**
   * 判断函数名是否可解析，供编辑器补全与 FlowRunner 静态检查使用。
   * @param name - 函数名
   */
  has(name: string): boolean
}
