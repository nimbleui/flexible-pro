import type {
  ExpressionBinaryOp,
  ExpressionLogicalOp,
  ExpressionNode,
  ExpressionUnaryOp,
} from '@lc/schema'
import type { Token } from './lexer'
import { tokenize } from './lexer'
import { ExpressionError } from './errors'

/**
 * 语法分析：Pratt（运算符优先级）解析器，产出 `@lc/schema` 定义的语法树。
 *
 * 优先级与 JS 对齐，但刻意只保留数据表达式需要的一档：
 * 三元 < `??`/`||` < `&&` < 相等 < 关系 < 加减 < 乘除 < 一元 < 后缀。
 * 没有赋值、位运算、`in`、`instanceof`、`typeof`、`new`、逗号表达式与正则字面量。
 */

/** 后缀（成员/下标/调用）绑得比任何运算符都紧，不入优先级表 */
const TERNARY_BP = 1
const UNARY_BP = 8

const LOGICAL_BINDING_POWER: Readonly<Record<string, number>> = {
  '??': 2,
  '||': 2,
  '&&': 3,
}

const BINARY_BINDING_POWER: Readonly<Record<string, number>> = {
  '==': 4,
  '!=': 4,
  '===': 4,
  '!==': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
}

const UNARY_PUNCTUATORS: readonly string[] = ['!', '-', '+']

const KEYWORD_LITERALS: Readonly<Record<string, string | number | boolean | null | undefined>> =
  {
    true: true,
    false: false,
    null: null,
    undefined: undefined,
  }

interface ParserState {
  readonly source: string
  readonly tokens: readonly Token[]
  pos: number
  /**
   * 当前位置是否允许出现箭头函数。
   *
   * 只在「实参位置」为 true。箭头函数如果被允许当作一等值，
   * 求值结果就是一个内部 Lambda 载体，会顺着 `resolveValue` 泄漏到渲染输出里；
   * 而它作为实参传给 `map` / `filter` 才是 `functions.ts` 里示例需要的全部能力。
   */
  allowArrow: boolean
}

function peek(state: ParserState): Token {
  return state.tokens[state.pos] ?? state.tokens[state.tokens.length - 1]
}

function advance(state: ParserState): Token {
  const token = peek(state)
  if (token.type !== 'eof') state.pos += 1
  return token
}

function isPunct(token: Token, text: string): boolean {
  return token.type === 'punct' && token.text === text
}

function fail(state: ParserState, message: string, token: Token): never {
  throw new ExpressionError('syntax', message, state.source, token.start)
}

function expectPunct(state: ParserState, text: string): void {
  const token = peek(state)
  if (!isPunct(token, text)) {
    fail(state, `期望 ${text}，实际得到 ${token.text || '<结尾>'}`, token)
  }
  advance(state)
}

/** 解析逗号分隔的表达式列表；结束符总是由本函数消费 */
function parseDelimited(state: ParserState, closer: string): ExpressionNode[] {
  const items: ExpressionNode[] = []

  if (!isPunct(peek(state), closer)) {
    for (;;) {
      items.push(parseExpression(state, 0))
      if (isPunct(peek(state), ',')) {
        advance(state)
        // 允许尾逗号：JSON 与 JS 都容忍，对用户严格只会增加无谓报错
        if (isPunct(peek(state), closer)) break
        continue
      }
      break
    }
  }

  expectPunct(state, closer)
  return items
}

function parsePrimary(state: ParserState): ExpressionNode {
  const token = peek(state)

  if (token.type === 'number' || token.type === 'string') {
    advance(state)
    return { kind: 'literal', value: token.literal }
  }

  if (token.type === 'name') {
    advance(state)

    if (token.text in KEYWORD_LITERALS) {
      return { kind: 'literal', value: KEYWORD_LITERALS[token.text] }
    }

    if (state.allowArrow && isPunct(peek(state), '=>')) {
      advance(state)
      return parseArrowBody(state, [token.text])
    }

    return { kind: 'identifier', name: token.text }
  }

  if (token.type === 'punct' && token.text === '(') {
    return parseParenthesized(state)
  }

  if (token.type === 'punct' && token.text === '[') {
    advance(state)
    const elements = parseDelimited(state, ']')
    return { kind: 'array', elements }
  }

  if (token.type === 'punct' && token.text === '{') {
    return parseObjectLiteral(state)
  }

  fail(state, `意外的符号 ${token.text || '<结尾>'}`, token)
}

/**
 * 括号分支：既可能是分组 `(a + b)`，也可能是箭头函数参数表 `(a, b) => ...`。
 *
 * 选择「先当表达式列表解析，看到 `=>` 再回判」而不是向前扫描：
 * 向前扫描需要处理嵌套括号与字符串，复杂度会超过本分支本身的价值。
 * 代价是参数表要按表达式解析，再逐个校验它确实是裸标识符。
 */
function parseParenthesized(state: ParserState): ExpressionNode {
  advance(state)
  const items = parseDelimited(state, ')')

  if (!isPunct(peek(state), '=>')) {
    if (items.length !== 1) {
      fail(state, '括号分组只能包含一个表达式', peek(state))
    }
    return items[0] as ExpressionNode
  }

  advance(state)

  const params = items.map((item) => {
    if (item.kind !== 'identifier') {
      fail(state, '箭头函数形参必须是名字', peek(state))
    }
    return item.name
  })

  return parseArrowBody(state, params)
}

/** 箭头函数体：形参绑定生效后，体内不再允许出现新的箭头函数（实参位置会重新打开） */
function parseArrowBody(state: ParserState, params: string[]): ExpressionNode {
  const enclosing = state.allowArrow
  state.allowArrow = false
  const body = parseExpression(state, 0)
  state.allowArrow = enclosing

  return { kind: 'arrow', params, body }
}

function parseObjectLiteral(state: ParserState): ExpressionNode {
  advance(state)
  const properties: { key: string; value: ExpressionNode }[] = []

  while (!isPunct(peek(state), '}')) {
    const keyToken = peek(state)
    let key: string

    if (keyToken.type === 'name') {
      key = keyToken.text
    } else if (keyToken.type === 'string') {
      key = String(keyToken.literal)
    } else {
      fail(state, '对象键名只能是名字或字符串', keyToken)
    }
    advance(state)
    expectPunct(state, ':')

    const enclosing = state.allowArrow
    state.allowArrow = false
    const value = parseExpression(state, 0)
    state.allowArrow = enclosing

    properties.push({ key, value })

    if (isPunct(peek(state), ',')) advance(state)
    else break
  }

  expectPunct(state, '}')
  return { kind: 'object', properties }
}

/** 后缀链：`.` `?.` `[]` `()`，从左到右反复扩展 */
function parsePostfix(state: ParserState): ExpressionNode {
  let node = parsePrimary(state)

  for (;;) {
    const token = peek(state)

    if (isPunct(token, '.')) {
      advance(state)
      const name = peek(state)
      if (name.type !== 'name') fail(state, '点号后面必须是属性名', name)
      advance(state)
      node = { kind: 'member', object: node, property: name.text, optional: false }
      continue
    }

    if (isPunct(token, '?.')) {
      advance(state)
      const next = peek(state)

      if (isPunct(next, '(')) {
        node = { kind: 'call', callee: node, args: parseArguments(state), optional: true }
        continue
      }
      if (isPunct(next, '[')) {
        advance(state)
        const index = parseExpression(state, 0)
        expectPunct(state, ']')
        node = { kind: 'index', object: node, index, optional: true }
        continue
      }

      const name = next
      if (name.type !== 'name') fail(state, '可选链后面必须是属性名', name)
      advance(state)
      node = { kind: 'member', object: node, property: name.text, optional: true }
      continue
    }

    if (isPunct(token, '[')) {
      advance(state)
      const enclosing = state.allowArrow
      state.allowArrow = false
      const index = parseExpression(state, 0)
      state.allowArrow = enclosing
      expectPunct(state, ']')
      node = { kind: 'index', object: node, index, optional: false }
      continue
    }

    if (isPunct(token, '(')) {
      node = { kind: 'call', callee: node, args: parseArguments(state), optional: false }
      continue
    }

    break
  }

  return node
}

/** 实参是箭头函数唯一允许出现的位置 */
function parseArguments(state: ParserState): ExpressionNode[] {
  expectPunct(state, '(')
  const enclosing = state.allowArrow
  state.allowArrow = true
  const args = parseDelimited(state, ')')
  state.allowArrow = enclosing
  return args
}

function parseUnary(state: ParserState): ExpressionNode {
  const token = peek(state)

  if (token.type === 'punct' && UNARY_PUNCTUATORS.includes(token.text)) {
    advance(state)
    const argument = parseExpression(state, UNARY_BP)
    return { kind: 'unary', op: token.text as ExpressionUnaryOp, argument }
  }

  return parsePostfix(state)
}

function parseInfix(state: ParserState, left: ExpressionNode, minBp: number): ExpressionNode {
  for (;;) {
    const token = peek(state)
    if (token.type !== 'punct') return left

    if (isPunct(token, '?')) {
      if (TERNARY_BP <= minBp) return left
      advance(state)
      const consequent = parseExpression(state, 0)
      expectPunct(state, ':')
      // 分支按最低优先级解析，得到右结合的 a ? b : c ? d : e
      const alternate = parseExpression(state, 0)
      left = { kind: 'conditional', test: left, consequent, alternate }
      continue
    }

    const logicalBp = LOGICAL_BINDING_POWER[token.text]
    if (logicalBp !== undefined && logicalBp > minBp) {
      advance(state)
      const right = parseExpression(state, logicalBp)
      left = { kind: 'logical', op: token.text as ExpressionLogicalOp, left, right }
      continue
    }

    const binaryBp = BINARY_BINDING_POWER[token.text]
    if (binaryBp !== undefined && binaryBp > minBp) {
      advance(state)
      const right = parseExpression(state, binaryBp)
      left = { kind: 'binary', op: token.text as ExpressionBinaryOp, left, right }
      continue
    }

    return left
  }
}

function parseExpression(state: ParserState, minBp: number): ExpressionNode {
  const left = parseUnary(state)
  return parseInfix(state, left, minBp)
}

/**
 * 把表达式文本解析成语法树根节点。
 *
 * 顶层入口的 `allowArrow` 固定为 false：箭头函数只能出现在实参位置，
 * 见 `ParserState.allowArrow` 注释。
 *
 * @throws ExpressionError kind 为 `syntax`，offset 指向出错 token
 */
export function parseExpressionSource(source: string): ExpressionNode {
  const state: ParserState = {
    source,
    tokens: tokenize(source),
    pos: 0,
    allowArrow: false,
  }

  const node = parseExpression(state, 0)
  const trailing = peek(state)
  if (trailing.type !== 'eof') {
    fail(state, `表达式末尾有多余内容 ${trailing.text}`, trailing)
  }

  return node
}
