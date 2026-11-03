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
 * 与 `EventChain / Action` 的区别：
 *  - 事件链是"有副作用的动作流水"
 *  - FunctionSchema 是"纯函数"（只输入输出，不产生副作用）
 *
 * 若要复杂副作用请用 Action / 事件连接；此声明形式设计用于表达式内。
 */

import type { ExpressionString } from './expression'

/** 值类型种类；`unknown` 表示编辑器无法静态判断，补全按宽松模式处理 */
export type ValueTypeKind = 'unknown' | 'string' | 'number' | 'boolean' | 'array' | 'object'

/**
 * 值类型结构。
 *
 * 只描述补全需要的形状，不是运行时校验器：`fields` 用于对象字段，
 * `item` 用于数组元素，其余类型无需子结构。由示例 JSON 或显式标注推导。
 */
export interface ValueTypeSchema {
  /**
   * 类型种类。
   *
   * 本结构整体只服务编辑器（补全、类型面板），运行时不做校验，因此允许出现
   * 与真实数据不符的标注；`unknown` 是推导失败时的兜底值，此时子字段一律忽略。
   */
  kind: ValueTypeKind
  /** 对象字段类型；键为字段名 */
  fields?: Record<string, ValueTypeSchema>
  /** 数组元素类型 */
  item?: ValueTypeSchema
  /** 字段说明；显示在补全详情里 */
  description?: string
  /** 字段在部分样本中缺失；仅对象字段有语义 */
  optional?: boolean
  /** 值可能为 null；补全仍按非空类型提示 */
  nullable?: boolean
}

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
   * 形参类型标注；键为 `params` 中的名字，缺省视为 unknown。
   *
   * 只服务编辑器补全与静态推断，不参与运行时绑定：表达式引擎依旧按位置
   * 传值，不因标注类型改变求值语义。
   */
  paramTypes?: Record<string, ValueTypeSchema>
  /**
   * 返回值类型标注（可选）。
   *
   * 缺省时编辑器会按函数体推断；显式标注只在推断无法得出类型时使用。
   */
  returns?: ValueTypeSchema
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
 * 自定义函数的注册层级，从低到高固定为 `global` → `material` → `page`。
 *
 * - `global`：应用级共享函数（函数管理页维护），对所有文档可见
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
export type FunctionScopeLevel = 'global' | 'material' | 'page'

/** 一次注册的句柄；dispose 幂等，重复调用不会撤销后续注册 */
export interface FunctionRegistration {
  /** 撤销本次注册涉及的全部函数，恢复到本次注册之前的解析结果 */
  dispose(): void
}

/**
 * 当前可调用函数的描述。
 *
 * 供编辑器补全、函数参考面板与文档生成使用；只描述函数面，不携带函数体实现。
 * 同名函数只出现在生效层级的那一条，调用方不需要自己再处理覆盖。
 */
export interface FunctionDescriptor {
  /** 函数名，表达式中按此名调用 */
  name: string
  /** 形参名列表；`...` 前缀表示可变参数 */
  params: readonly string[]
  /** 形参类型标注；键为形参名 */
  paramTypes?: Readonly<Record<string, ValueTypeSchema>>
  /** 生效函数的返回类型；自定义函数缺省时由函数体推断 */
  returns?: ValueTypeSchema
  /** 展示标题（可选） */
  title?: string
  /** 说明（可选） */
  description?: string
  /** 生效来源：内置函数或某一注册层级 */
  scope: FunctionScopeLevel | 'builtin'
}

/**
 * 自定义函数注册表。
 *
 * 保持为「内置表 + 按名字分栈 + 注销句柄」，不做成插件扩展点：
 * 内置函数由引擎自身提供，全局/物料/页面三层由注册方按层级声明，
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
   * 判断函数名是否可解析，供编辑器补全与运行时静态检查使用。
   * @param name - 函数名
   */
  has(name: string): boolean

  /**
   * 列出当前所有可解析函数（内置 + 各注册层的生效项）。
   *
   * 同名只返回最终生效的那一条，与调用时的解析结果一致；注册失败或函数体
   * 编译失败的条目不会出现，因为它们本来也无法被调用。
   *
   * @returns 稳定顺序的描述列表：先内置函数，再按注册顺序排列的自定义函数
   */
  describe(): readonly FunctionDescriptor[]
}
