import { ExpressionError } from './errors'

/**
 * 词法单元类型。
 *
 * `name` 同时承载普通标识符与关键字（`true` / `false` / `null` / `undefined`），
 * 由语法分析阶段决定它落成字面量还是变量引用。
 */
export type TokenType = 'number' | 'string' | 'name' | 'punct' | 'eof'

/** 单个词法单元。 */
export interface Token {
  /** 词法类别；`name` 同时承载关键字，落成语义由语法层决定 */
  readonly type: TokenType
  /** 源码原文片段 */
  readonly text: string
  /** number / string 转义解码后的字面值；其余类型为 undefined */
  readonly literal: string | number | undefined
  /** 在源码中的起始下标（含），与编辑器报错定位共用同一坐标空间 */
  readonly start: number
  /** 在源码中的结束下标（不含），可直接用于原文 slice */
  readonly end: number
}

/**
 * 按「最长匹配优先」排列：多字符运算符必须排在它的单字符前缀之前，
 * 否则 `<=` 会被切成 `<` 加 `=`。
 */
const PUNCTUATORS = [
  '===',
  '!==',
  '??',
  '?.',
  '=>',
  '&&',
  '||',
  '==',
  '!=',
  '<=',
  '>=',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  '.',
  ':',
  '?',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '<',
  '>',
]

const SPACE_PATTERN = /\s+/uy
const NAME_PATTERN = /[_$\p{L}][_$\p{L}\p{N}]*/uy
const NUMBER_PATTERN = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/uy

/** 数字首字符判定；放在数字模式匹配之前，避免标识符规则抢先吃掉 `1abc` 的 `1` */
const DIGIT_PATTERN = /\d/uy

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  '"': '"',
  "'": "'",
  '`': '`',
}

/**
 * 解析一个 `\` 起始的转义序列。
 *
 * 返回解码文本与下一待读位置：`\uXXXX` 连同反斜杠消费 6 个字符，其余转义消费 2 个。
 * 非法或不认识的 `\u` 序列退化为普通转义处理（按原字符保留），与 `scanString`
 * 的宽松策略保持一致。
 */
function readEscape(
  source: string,
  index: number,
): { readonly text: string; readonly next: number } {
  const next = source[index + 1]
  if (next === undefined) return { text: '', next: index + 1 }

  if (next === 'u') {
    const hex = source.slice(index + 2, index + 6)
    const code = Number.parseInt(hex, 16)
    if (!Number.isNaN(code) && hex.length === 4) {
      return { text: String.fromCharCode(code), next: index + 6 }
    }
  }

  return { text: SIMPLE_ESCAPES[next] ?? next, next: index + 2 }
}

/** 组装字符串 token；`text` 取原文（含引号），`literal` 是解码后的值 */
function stringToken(source: string, start: number, end: number, value: string): Token {
  return { type: 'string', text: source.slice(start, end), literal: value, start, end }
}

/**
 * 扫描字符串字面量，处理单引号/双引号与常见转义。
 *
 * 未识别的转义（如 `\q`）按原字符保留而不是报错：表达式文本常从 JSON 里粘贴过来，
 * 多余的反斜杠属于书写噪声，报错对设计器用户没有价值。
 * 不支持 `\u{...}` 码点形式，只支持 `\uXXXX`。
 */
function scanString(source: string, start: number): Token {
  const quote = source[start]
  let value = ''
  let index = start + 1

  while (index < source.length) {
    const char = source[index]

    if (char === '\\') {
      const escape = readEscape(source, index)
      value += escape.text
      index = escape.next
      continue
    }

    if (char === quote) return stringToken(source, start, index + 1, value)

    value += char
    index += 1
  }

  throw new ExpressionError('syntax', '字符串字面量未闭合', source, start)
}

/**
 * 把表达式文本切成词法单元数组，末尾恒定补一个 `eof`。
 *
 * 标识符允许 Unicode 字母（`\p{L}`）：低代码数据字段大量使用中文键名，
 * 若只允许 ASCII，`{{ 用户名 }}` 这类写法会被判成语法错误。
 * 刻意不支持模板字符串 `` `...${}...` `` —— 它与引擎已有的 `{{ }}` 插值
 * 是同一能力的两种写法，留着只会让词法分析多出一套带嵌套的扫描状态。
 *
 * @throws ExpressionError 出现无法识别的字符，或字符串未闭合
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let pos = 0

  while (pos < source.length) {
    SPACE_PATTERN.lastIndex = pos
    if (SPACE_PATTERN.test(source)) {
      pos = SPACE_PATTERN.lastIndex
      continue
    }

    DIGIT_PATTERN.lastIndex = pos
    if (DIGIT_PATTERN.test(source)) {
      NUMBER_PATTERN.lastIndex = pos
      const matched = NUMBER_PATTERN.exec(source)
      const text = matched?.[0]
      if (!text) {
        throw new ExpressionError('syntax', '数字字面量格式非法', source, pos)
      }
      tokens.push({
        type: 'number',
        text,
        literal: Number(text),
        start: pos,
        end: pos + text.length,
      })
      pos += text.length
      continue
    }

    const char = source[pos]
    if (char === '"' || char === "'") {
      const token = scanString(source, pos)
      tokens.push(token)
      pos = token.end
      continue
    }

    NAME_PATTERN.lastIndex = pos
    const name = NAME_PATTERN.exec(source)
    if (name) {
      tokens.push({
        type: 'name',
        text: name[0],
        literal: undefined,
        start: pos,
        end: pos + name[0].length,
      })
      pos += name[0].length
      continue
    }

    const punct = PUNCTUATORS.find((candidate) => source.startsWith(candidate, pos))
    if (punct) {
      tokens.push({
        type: 'punct',
        text: punct,
        literal: undefined,
        start: pos,
        end: pos + punct.length,
      })
      pos += punct.length
      continue
    }

    throw new ExpressionError('syntax', `无法识别的字符 ${JSON.stringify(char)}`, source, pos)
  }

  tokens.push({
    type: 'eof',
    text: '',
    literal: undefined,
    start: source.length,
    end: source.length,
  })
  return tokens
}
