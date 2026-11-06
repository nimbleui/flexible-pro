import type { ExpressionNode } from '@lc/schema'
import { isBuiltinFunction } from '@lc/expression'
import { splitTemplate } from '@lc/expression/editor'
import type { CodegenContext } from './context'
import { quote } from './naming'

/** 出码时用到的表达式文本 */
export interface EmittedExpression {
  /** 可直接嵌进 JS 的表达式文本 */
  js: string
  /** 语法不合法时给出原因；此时 js 退化成原样字符串字面量 */
  error?: string
}

/** 内置函数名到 `$rt` 成员名的映射；语义与 `packages/expression/src/host.ts` 一一对应 */
const BUILTIN_RUNTIME: Readonly<Record<string, string>> = {
  abs: 'abs',
  min: 'min',
  max: 'max',
  round: 'round',
  floor: 'floor',
  ceil: 'ceil',
  number: 'num',
  string: 'str',
  boolean: 'bool',
  stringify: 'json',
  isEmpty: 'isEmpty',
  isBlank: 'isBlank',
}

/**
 * JS 运算符优先级，只覆盖白名单语言用到的档位。
 *
 * 取值与 JS 规范一致，所以「不加括号也读对」和「必须加括号」的边界不靠感觉判断。
 */
const PRECEDENCE: Readonly<Record<string, number>> = {
  '||': 5,
  '??': 5,
  '&&': 6,
  '==': 9,
  '!=': 9,
  '===': 10,
  '!==': 10,
  '<': 10,
  '<=': 10,
  '>': 10,
  '>=': 10,
  '+': 11,
  '-': 11,
  '*': 13,
  '/': 13,
  '%': 13,
}

const PREC_CONDITIONAL = 4
const PREC_UNARY = 15
const PREC_POSTFIX = 18
const PREC_LEAF = 20

/** 节点作为整体时的优先级，决定它被放进更高优先级位置时要不要加括号 */
function precedenceOf(node: ExpressionNode): number {
  switch (node.kind) {
    case 'conditional':
      return PREC_CONDITIONAL
    case 'logical':
    case 'binary':
      return PRECEDENCE[node.op] ?? PREC_CONDITIONAL
    case 'unary':
      return PREC_UNARY
    case 'literal':
    case 'identifier':
      return PREC_LEAF
    default:
      return PREC_POSTFIX
  }
}

/** 字面量的 JS 文本；`undefined` 不是合法 JSON，单独处理 */
function literalText(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return quote(value)
  return JSON.stringify(value)
}

/** 对象字面量的键：合法标识符裸写，其余一律引号包裹 */
function propertyKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? key : quote(key)
}

/**
 * 语法树 → JS 文本。
 *
 * 左结合运算符的右操作数要求严格更高的优先级，所以 `a - (b - c)` 会被括起来，
 * 而 `a + b + c` 不会——这是直译最容易出错的一处，因此单独用优先级而不是无脑加括号：
 * 满屏括号会让出码结果失去可读性，也就失去了这个页签的意义。
 *
 * @param minPrec 该位置允许的最低优先级
 */
function emitNode(node: ExpressionNode, ctx: CodegenContext, minPrec: number): string {
  const text = emitBare(node, ctx)
  return precedenceOf(node) < minPrec ? `(${text})` : text
}

function emitBare(node: ExpressionNode, ctx: CodegenContext): string {
  switch (node.kind) {
    case 'literal':
      return literalText(node.value)

    case 'identifier':
      return node.name

    case 'member': {
      const object = emitNode(node.object, ctx, PREC_POSTFIX)
      return `${object}${node.optional ? '?.' : '.'}${node.property}`
    }

    case 'index': {
      const object = emitNode(node.object, ctx, PREC_POSTFIX)
      const index = emitNode(node.index, ctx, 0)
      return `${object}${node.optional ? '?.' : ''}[${index}]`
    }

    case 'call':
      return emitCall(node, ctx)

    case 'unary':
      return `${node.op}${emitNode(node.argument, ctx, PREC_UNARY)}`

    case 'binary':
    case 'logical': {
      const prec = precedenceOf(node)
      const left = emitNode(node.left, ctx, prec)
      const right = emitNode(node.right, ctx, prec + 1)
      return `${left} ${node.op} ${right}`
    }

    case 'conditional': {
      const test = emitNode(node.test, ctx, PREC_CONDITIONAL + 1)
      const consequent = emitNode(node.consequent, ctx, 0)
      const alternate = emitNode(node.alternate, ctx, PREC_CONDITIONAL)
      return `${test} ? ${consequent} : ${alternate}`
    }

    case 'array':
      return `[${node.elements.map((item) => emitNode(item, ctx, 0)).join(', ')}]`

    case 'object': {
      const pairs = node.properties.map(
        (property) => `${propertyKey(property.key)}: ${emitNode(property.value, ctx, 0)}`,
      )
      return `{ ${pairs.join(', ')} }`
    }

    case 'arrow': {
      const body =
        // 函数体是对象字面量时必须括起来，否则 `x => { a: 1 }` 被读成语句块
        node.body.kind === 'object'
          ? `(${emitNode(node.body, ctx, 0)})`
          : emitNode(node.body, ctx, 0)
      return `(${node.params.join(', ')}) => ${body}`
    }
  }
}

/**
 * 调用节点的出码规则。
 *
 * 内置函数改写成 `$rt.*`：白名单的 `number('')` 与 JS 的 `Number('')` 行为不同
 * （前者拒绝对象与数组并抛错），直译会把设计期的行为改掉。其余调用原样输出，
 * 因为白名单允许的方法名本来就是 JS 原生方法名。
 */
function emitCall(node: ExpressionNode & { kind: 'call' }, ctx: CodegenContext): string {
  const args = node.args.map((arg) => emitNode(arg, ctx, 0)).join(', ')

  if (node.callee.kind === 'identifier') {
    const runtime = BUILTIN_RUNTIME[node.callee.name]
    if (runtime && isBuiltinFunction(node.callee.name)) {
      ctx.runtimeNeeds.add(runtime)
      return `$rt.${runtime}(${args})`
    }
  }

  const callee =
    node.callee.kind === 'identifier'
      ? node.callee.name
      : emitNode(node.callee, ctx, PREC_POSTFIX)

  return `${callee}${node.optional ? '?.' : ''}(${args})`
}

/** 模板静态文本转成 JS 模板字面量片段；反斜杠、反引号与 `${` 都要转义 */
function escapeTemplateText(text: string): string {
  return text.replace(/\\/gu, '\\\\').replace(/`/gu, '\\`').replace(/\$\{/gu, '\\${')
}

/**
 * 出码一段表达式文本。
 *
 * 语法错误不中断整体出码：该段退化成原样字符串并带回 error，由面板汇总成警告清单。
 * 一条写坏的表达式不该让整页代码生不出来。
 *
 * @param text 表达式或模板原文
 * @param mode `expression` 整段是表达式；`template` 只把 `{{ ... }}` 当插值
 * @param ctx 出码上下文，内置函数与运行时依赖记在这里
 */
export function emitExpression(
  text: string,
  mode: 'expression' | 'template',
  ctx: CodegenContext,
): EmittedExpression {
  try {
    if (mode === 'expression') return { js: emitBare(ctx.compile(text), ctx) }

    const segments = splitTemplate(text)
    if (!segments.some((segment) => segment.kind === 'expression')) {
      return { js: quote(text) }
    }

    // 插值走 $rt.str：引擎把 null / undefined 转成空串，JS 模板字面量会写出 "null"
    ctx.runtimeNeeds.add('str')
    const parts = segments.map((segment) =>
      segment.kind === 'text'
        ? escapeTemplateText(segment.text)
        : `\${$rt.str(${emitBare(ctx.compile(segment.text), ctx)})}`,
    )

    return { js: '`' + parts.join('') + '`' }
  } catch (error) {
    return {
      js: quote(text),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 把已出码的表达式体包成箭头函数。
 *
 * 体是对象字面量时必须括起来，否则 `(item) => { id: 1 }` 被读成语句块并返回 undefined。
 * 判断只看首字符是够的：直译产物的顶层形态只有「对象字面量以 `{` 开头」这一种会踩到。
 */
export function emitArrow(params: readonly string[], bodyJs: string): string {
  const body = bodyJs.startsWith('{') ? `(${bodyJs})` : bodyJs
  return `(${params.join(', ')}) => ${body}`
}
