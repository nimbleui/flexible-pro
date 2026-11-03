/**
 * 表达式（Expression）架构定义
 * ---
 * 本文件是表达式语言的**唯一契约来源**，包含四部分内容：
 * 1. 表达式值的两种承载形式 —— `ExpressionString`（`{{ a + b }}` 白名单表达式）
 *    与 `JsExpression`（宿主受信代码片段）。
 * 2. 表达式语法树（AST）的节点定义。
 * 3. 求值契约 `ExpressionEngine` —— 注入渲染器与运行时的接口。
 * 4. 求值作用域 `ExpressionScope` 与编译产物 `CompiledExpression`。
 *
 * 自定义函数的注册契约 `FunctionRegistry` 定义在 `functions.ts`，与被注册的
 * `FunctionSchema` 同处一文件；本文件与 `functions.ts` 因此存在纯类型层面的
 * 相互引用。`import type` 在编译期被完全擦除，不产生运行时循环依赖。
 *
 * AST 之所以定义在本包而不是引擎包：`@lc/schema` 被内核、契约层、插件、运行时
 * 共同依赖且零依赖，语法树是 DSL 契约的一部分。设计器校验、编辑器补全
 * 与引擎求值必须共用同一份节点定义，否则会各自演化出
 * 互不兼容的语法树。引擎包（`@lc/expression`）反向依赖本包获取这些类型。
 */

import type { FunctionRegistry } from './functions'

/**
 * 模板表达式字符串接口
 * 表示一个使用双花括号语法包裹的动态表达式，如 "{{ user.name }}"。
 * 表达式在运行时由表达式引擎解析，从数据上下文中提取对应的值。
 */
export interface ExpressionString {
  /** 类型标识，固定为 'expression'，用于类型区分 */
  type: 'expression'
  /** 原始表达式字符串内容，如 "{{ user.name }}" */
  raw: string
}

/**
 * 原生 JavaScript 表达式接口
 * 表示一段由宿主直接执行的 JavaScript 代码，是白名单语言的**受信逃生门**。
 *
 * 白名单表达式（`ExpressionString`）覆盖设计器产出的全部动态绑定；本类型只用于
 * 白名单语法确实表达不了、且写入方与物料代码同属受信层的场景。
 * 引擎默认拒绝求值本类型，需要宿主显式开启 `allowUnsafeJs` 能力位；
 * 关闭时求值结果为 `undefined` 并上报诊断，因此 CSP 禁用 `unsafe-eval` 的
 * 运行时可以整体禁用这一承载形式。
 */
export interface JsExpression {
  /** 类型标识，固定为 'js'，用于类型区分 */
  type: 'js'
  /** 可执行的 JavaScript 代码字符串 */
  code: string
}

/**
 * 类型守卫函数：判断一个未知值是否为 ExpressionString 类型
 * 通过检查值是否为非空对象、类型标识是否为 'expression'
 * 以及 raw 字段是否为字符串来进行判断。
 * 用于在运行时安全地处理动态表达式值。
 *
 * @param value - 要检测的未知类型值
 * @returns 如果值是 ExpressionString 类型则返回 true
 */
export function isExpressionString(value: unknown): value is ExpressionString {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ExpressionString).type === 'expression' &&
    typeof (value as ExpressionString).raw === 'string'
  )
}

/**
 * 类型守卫函数：判断一个未知值是否为 JsExpression 类型
 * 通过检查值是否为非空对象、类型标识是否为 'js'
 * 以及 code 字段是否为字符串来进行判断。
 *
 * @param value - 要检测的未知类型值
 * @returns 如果值是 JsExpression 类型则返回 true
 */
export function isJsExpression(value: unknown): value is JsExpression {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as JsExpression).type === 'js' &&
    typeof (value as JsExpression).code === 'string'
  )
}

/**
 * 创建模板表达式对象的工厂函数
 * 便捷地生成一个 ExpressionString 实例，避免手动构造对象。
 *
 * @param raw - 模板表达式字符串，如 "{{ user.name }}"
 * @returns 新创建的 ExpressionString 对象
 */
export function createExpression(raw: string): ExpressionString {
  return { type: 'expression', raw }
}

/**
 * 创建原生 JS 表达式对象的工厂函数
 * 便捷地生成一个 JsExpression 实例，避免手动构造对象。
 *
 * @param code - 可执行的 JavaScript 代码字符串
 * @returns 新创建的 JsExpression 对象
 */
export function createJsExpression(code: string): JsExpression {
  return { type: 'js', code }
}

/**
 * 表达式求值作用域。
 * 键为表达式中可直接书写的裸标识符，值保留原始类型。
 * 由消费方（渲染器、动作执行器、数据源管道）按自己的上下文结构构造。
 */
export type ExpressionScope = Record<string, unknown>

/**
 * 二元运算符集合。
 *
 * 刻意不含位运算、`in`、`instanceof`、`typeof` 与赋值：白名单语言只需要
 * 数据比较与拼接，其余语义要么需要原型链访问，要么会诱导设计器产出
 * 无法静态校验的表达式。
 */
export type ExpressionBinaryOp =
  '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '===' | '!==' | '<' | '<=' | '>' | '>='

/** 短路运算符集合；`??` 与 `||` 同级、左结合 */
export type ExpressionLogicalOp = '&&' | '||' | '??'

/** 一元运算符集合 */
export type ExpressionUnaryOp = '-' | '+' | '!'

/** 字面量节点；`undefined` 与 `null` 都用本节点表达，不额外设节点类型 */
export interface ExpressionLiteralNode {
  /** 可辨识字段，求值器按它分派 */
  kind: 'literal'
  /**
   * 解析期就折成常量的值，求值时原样返回。
   *
   * 含 `undefined`：它在语法上是 name token，由解析层的关键字表折成本节点，
   * 因此不会进入作用域查找、也不会触发 unbound-identifier 诊断。
   */
  value: string | number | boolean | null | undefined
}

/** 裸标识符节点，如 `user`、`$item` */
export interface ExpressionIdentifierNode {
  /** 可辨识字段 */
  kind: 'identifier'
  /**
   * 作用域里的裸键名。
   *
   * 只查帧对象自有键，不沿原型链；名字不存在时求值为 `undefined` 并上报诊断，
   * 不抛错——`{{ x ?? 1 }}` 这类容错写法依赖这一行为。
   */
  name: string
}

/** 点访问节点，如 `user.name`；`user?.name` 时 optional 为 true */
export interface ExpressionMemberNode {
  /** 可辨识字段 */
  kind: 'member'
  /** 接收者表达式；求值结果只按自有属性读取，函数对象一律拒绝 */
  object: ExpressionNode
  /** 点号后的属性名，只可能是标识符，不接受计算属性 */
  property: string
  /** `?.` 记号；接收者为 null/undefined 时短路返回 undefined，否则报无效操作 */
  optional: boolean
}

/** 下标访问节点，如 `list[0]`、`data['a-b']` */
export interface ExpressionIndexNode {
  /** 可辨识字段 */
  kind: 'index'
  /** 接收者表达式，约束同 member */
  object: ExpressionNode
  /**
   * 下标表达式本身（可为变量或拼接）。
   *
   * 求值结果只接受 string / number，其余类型报无效操作；数组的负下标不属于
   * 本节点，要用 `at(-1)` 方法表达。
   */
  index: ExpressionNode
  /** `?.[]` 记号；只作用于本次取值，不传递给后续后缀 */
  optional: boolean
}

/**
 * 调用节点。
 *
 * `callee` 为 `identifier` 时表示函数调用（内置 / 自定义 / 宿主注入），
 * 为 `member` 或 `index` 时表示接收者方法调用，由引擎按接收者类型查白名单表。
 */
export interface ExpressionCallNode {
  /** 可辨识字段 */
  kind: 'call'
  /** 被调用对象；解析顺序固定为注册表 → 作用域函数值 → 报错 */
  callee: ExpressionNode
  /** 实参，按从左到右求值；箭头函数只在这些位置会被转成 JS 回调 */
  args: ExpressionNode[]
  /** `?.()` 记号；被调对象为 null/undefined 时整次调用返回 undefined */
  optional: boolean
}

/** 一元运算节点 */
export interface ExpressionUnaryNode {
  /** 可辨识字段 */
  kind: 'unary'
  /** 运算符；`!` 走布尔转换，`-` / `+` 走数字转换，不含位运算与 `typeof` */
  op: ExpressionUnaryOp
  /** 运算对象 */
  argument: ExpressionNode
}

/** 二元运算节点 */
export interface ExpressionBinaryNode {
  /** 可辨识字段 */
  kind: 'binary'
  /** 运算符；两侧操作数都会被求值（本节点不承担短路语义） */
  op: ExpressionBinaryOp
  /** 左操作数 */
  left: ExpressionNode
  /** 右操作数 */
  right: ExpressionNode
}

/** 短路运算节点；未求值的分支不产生副作用 */
export interface ExpressionLogicalNode {
  /** 可辨识字段 */
  kind: 'logical'
  /** 运算符；`??` 只看 null/undefined，`&&` / `||` 按引擎的布尔转换 */
  op: ExpressionLogicalOp
  /** 左操作数，总是先求值 */
  left: ExpressionNode
  /** 右操作数，只在需要时求值 */
  right: ExpressionNode
}

/** 三元条件节点 */
export interface ExpressionConditionalNode {
  /** 可辨识字段 */
  kind: 'conditional'
  /** 判定表达式，按引擎的布尔转换（不是 JS 的真值） */
  test: ExpressionNode
  /** 判定为真时求值的分支 */
  consequent: ExpressionNode
  /** 判定为假时求值的分支；语法上必填，白名单不支持省略 `: x` 的写法 */
  alternate: ExpressionNode
}

/** 数组字面量节点，如 `[1, 2]` */
export interface ExpressionArrayNode {
  /** 可辨识字段 */
  kind: 'array'
  /**
   * 元素表达式，逐项求值。
   *
   * 允许尾逗号，但不允许稀疏空位（`[1, , 3]` 语法报错），
   * 因此本数组长度与求值后的数组长度始终一致。
   */
  elements: ExpressionNode[]
}

/** 对象字面量节点，如 `{ a: 1, 'b-c': a }` */
export interface ExpressionObjectNode {
  /** 可辨识字段 */
  kind: 'object'
  /**
   * 属性列表，按书写顺序写入。
   *
   * 键只可能是标识符或字符串字面量；重名时后写的覆盖先写的。
   * 键名不做危险名校验，因为读取口只认自有数据属性，写毒路径已在读取侧封死。
   */
  properties: {
    /** 属性名，写入前不做规范化 */
    key: string
    /** 属性值表达式 */
    value: ExpressionNode
  }[]
}

/**
 * 箭头函数节点，如 `t => t.done`、`(a, b) => a + b`。
 *
 * 只允许作为实参出现（传给 `map` / `filter` / `reduce` 等高阶方法），
 * 不作为一等值存储或返回 —— 否则需要实现完整闭包语义，而声明式函数的
 * 输入输出契约（见 `functions.ts`）并不要求这一点。
 */
export interface ExpressionArrowNode {
  /** 可辨识字段 */
  kind: 'arrow'
  /**
   * 形参名，按宿主回调的实参位置绑定。
   *
   * 不校验重名：后声明的形参会覆盖同名前者的绑定，属于设计器可自查的小问题，
   * 不值得为此在语法层增加一遍扫描。
   */
  params: string[]
  /** 函数体表达式 */
  body: ExpressionNode
}

/**
 * 白名单表达式语法树节点的可辨识联合。
 *
 * 节点上不携带源码位置信息：位置只在校验报错时有用，而校验发生在解析阶段，
 * 由语法错误对象承载偏移量即可。给每个节点加 span 会让 AST 体积与解析成本
 * 明显上升，却在渲染路径上无人消费；等编辑器补全真正需要区间时再加。
 */
export type ExpressionNode =
  | ExpressionLiteralNode
  | ExpressionIdentifierNode
  | ExpressionMemberNode
  | ExpressionIndexNode
  | ExpressionCallNode
  | ExpressionUnaryNode
  | ExpressionBinaryNode
  | ExpressionLogicalNode
  | ExpressionConditionalNode
  | ExpressionArrayNode
  | ExpressionObjectNode
  | ExpressionArrowNode

/** 一次解析的产物；语义上等同于根节点 */
export type ExpressionAst = ExpressionNode

/**
 * 已编译表达式。
 *
 * 存在的原因是 schema 里两处已写明的承诺：
 *  - `functions.ts` 「内部通过 engine.compile 一次编译反复调用」
 *  - 动作执行器在循环执行动作时不能每轮重新解析同一串文本
 *
 * `ast` 暴露给设计器校验与编辑器补全使用，渲染路径不应依赖它。
 */
export interface CompiledExpression {
  /** 编译时使用的原始文本（已剥离 `{{ }}` 外壳） */
  readonly source: string
  /** 解析结果语法树 */
  readonly ast: ExpressionAst
  /**
   * 在给定作用域下求值。
   *
   * 与 `ExpressionEngine.evaluate` 的关键差别：**本方法会抛错**。
   * 引擎顶层方法面向渲染，必须吞掉异常并上报诊断以免白屏；
   * 本方法面向动作执行器、自定义函数等需要区分「结果为假」与「求值失败」的调用方，
   * 异常语义必须由调用方决定。
   *
   * @throws 语法错误已由 `compile` 提前抛出；此处只抛运行期错误
   *   （禁用属性访问、未知函数、类型不支持的方法调用、求值预算超限等）
   */
  evaluate(scope: ExpressionScope): unknown
}

/**
 * 表达式求值引擎的接口定义。
 * 注入到渲染器与运行时上下文中，负责表达式求值、模板插值与自定义函数注册。
 */
export interface ExpressionEngine {
  /**
   * 对单个表达式字符串进行求值，返回原始结果（保留类型 — 数字、布尔值等）。
   *
   * 边界行为：语法或运行期错误不向上抛，返回 `undefined` 并上报诊断，
   * 因为渲染单个表达式失败不应让整棵画布消失。需要区分「结果为 undefined」与
   * 「求值失败」时，改用 `compile(...).evaluate(scope)`。
   *
   * @param expr - 表达式字符串，允许带 `{{ }}` 外壳
   * @param scope - 求值作用域数据
   * @returns 求值结果，类型取决于表达式本身；失败时为 `undefined`
   */
  evaluate(expr: string, scope: ExpressionScope): unknown

  /**
   * 对包含 `{{ ... }}` 插值标记的模板字符串进行插值，返回字符串结果。
   * 非字符串值会被强制转换为字符串；`null` 与 `undefined` 转为空串。
   * @param template - 包含插值标记的模板
   * @param scope - 插值作用域数据
   * @returns 插值后的字符串
   */
  interpolate(template: string, scope: ExpressionScope): string

  /**
   * 判断某个值是否为需要求值的表达式引用。
   * @param value - 待检测的值
   * @returns 如果值是 ExpressionString 类型则返回 true
   */
  isExpression(value: unknown): value is ExpressionString

  /**
   * 编译表达式文本，得到可反复求值的对象。
   *
   * 结果按文本缓存，重复编译同一串返回同一对象；缓存有上限，
   * 因为设计器里用户逐字符编辑表达式，每个中间态都是一个不同的键。
   *
   * @param expr - 表达式文本，允许带 `{{ }}` 外壳
   * @throws 语法不合法时抛出，携带源码偏移量
   */
  compile(expr: string): CompiledExpression

  /**
   * 递归解析一个 schema 值：表达式对象、`{{ }}` 字符串、数组与嵌套对象全部求值。
   *
   * 抽到引擎的原因是同一套解析规则已有三个潜在使用者（渲染树、
   * `ActionDeclaration.config`、数据源的参数映射），而各写一遍必然在
   * 「数组里的字符串要不要插值」这类细节上分叉。
   *
   * 边界行为：递归深度超过上限时该子树原样返回并上报诊断，不抛错，
   * 以兼容 schema 中可能出现的自引用结构。
   *
   * @param value - 待解析的 schema 值
   * @param scope - 求值作用域数据
   * @returns 解析后的值；非表达式部分保持原样与原类型
   */
  resolveValue(value: unknown, scope: ExpressionScope): unknown

  /** 自定义函数注册表；`PageSchema.functions` 与 `ComponentSchema.functions` 的落点 */
  readonly functions: FunctionRegistry
}
