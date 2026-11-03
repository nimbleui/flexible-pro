import type { FunctionDescriptor } from '@lc/schema'
import type { HostReceiverType } from '../host'
import { tokenize } from '../lexer'
import type { Token } from '../lexer'
import type { MethodDoc } from './catalog'
import { METHOD_DOCS } from './catalog'

/**
 * 函数调用签名提示。
 *
 * 与补全一样只依赖词法：从光标向前找最近一个未闭合的 `(`，
 * 它前面的标识符就是当前正在填参数的函数；逗号计数只在当前括号层级生效，
 * 嵌套调用（`abs(min(1, `）因此能定位到内层。
 */

export interface SignatureHelp {
  /** 正在调用的函数名 */
  name: string
  /** 形参名列表；`...` 前缀表示可变参数 */
  params: readonly string[]
  /** 当前光标所在形参的下标，从 0 开始 */
  activeParameter: number
  /** 函数说明或方法说明 */
  documentation?: string
  /** 调用来源：自定义/内置函数，或数组/字符串/数字方法 */
  kind: 'function' | 'method'
  /** 函数名 token 的起点，便于编辑器把签名定位回文本 */
  from: number
  /** 光标位置 */
  to: number
}

/**
 * 签名提示的输入上下文。
 *
 * `text` 与 `offset` 必须是同一坐标空间的字符下标（编辑器内部坐标，
 * 模板模式下为整段属性值文本，不是 `{{ }}` 内层文本）。
 */
export interface SignatureContext {
  /** 完整文本；提示计算只消费 `text.slice(0, offset)` */
  text: string
  /** 光标偏移量（0 ~ text.length），越界时按端点钳制 */
  offset: number
  /** 当前可见的函数清单，通常来自 `FunctionRegistry.describe()` */
  functions: readonly FunctionDescriptor[]
}

const RECEIVER_TYPES: readonly HostReceiverType[] = ['array', 'string', 'number']

function methodDocByName(name: string): MethodDoc | undefined {
  for (const receiver of RECEIVER_TYPES) {
    const doc = METHOD_DOCS[receiver].find((item) => item.name === name)
    if (doc) return doc
  }
  return undefined
}

/** 方法文档的签名是展示文本，这里只拆出形参名用于参数定位 */
function paramsFromSignature(signature: string): string[] {
  const open = signature.indexOf('(')
  const close = signature.lastIndexOf(')')
  if (open < 0 || close <= open) return []

  return signature
    .slice(open + 1, close)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function documentationOf(descriptor: FunctionDescriptor): string | undefined {
  return [descriptor.title, descriptor.description].filter(Boolean).join(' · ') || undefined
}

/**
 * 从光标前 token 尾部向前找最近一个未闭合的调用左括号。
 *
 * @returns 该左括号的下标；不存在未闭合括号、或未闭合的最外层是 `[` / `{`
 *   （数组、对象字面量不是调用）时返回 -1
 */
function findUnclosedCall(list: readonly Token[]): number {
  let depth = 0

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const token = list[index]
    if (!token || token.type !== 'punct') continue

    if (token.text === ')' || token.text === ']' || token.text === '}') {
      depth += 1
      continue
    }

    if (token.text === '(' || token.text === '[' || token.text === '{') {
      if (depth > 0) {
        depth -= 1
        continue
      }
      // 数组/对象字面量不是调用，不提供签名
      return token.text === '(' ? index : -1
    }
  }

  return -1
}

/** 统计当前括号层级内的顶层逗号以定位活动形参；嵌套调用里的逗号不计入 */
function countActiveParameter(list: readonly Token[], openIndex: number): number {
  let activeParameter = 0
  let nested = 0

  for (let index = openIndex + 1; index < list.length; index += 1) {
    const token = list[index]
    if (!token || token.type !== 'punct') continue

    if (token.text === '(' || token.text === '[' || token.text === '{') nested += 1
    else if (token.text === ')' || token.text === ']' || token.text === '}') nested -= 1
    else if (token.text === ',' && nested === 0) activeParameter += 1
  }

  return activeParameter
}

/** 自定义 / 内置函数的签名项 */
function descriptorHelp(
  descriptor: FunctionDescriptor,
  nameToken: Token,
  activeParameter: number,
  to: number,
): SignatureHelp {
  return {
    name: descriptor.name,
    params: descriptor.params,
    activeParameter,
    documentation: documentationOf(descriptor),
    kind: 'function',
    from: nameToken.start,
    to,
  }
}

/** 宿主方法的签名项；形参表从方法文档的展示文本拆出，匹配不到文档时返回 null */
function methodHelp(
  nameToken: Token,
  activeParameter: number,
  to: number,
): SignatureHelp | null {
  const method = methodDocByName(nameToken.text)
  if (!method) return null

  return {
    name: nameToken.text,
    params: paramsFromSignature(method.signature),
    activeParameter,
    documentation: method.description,
    kind: 'method',
    from: nameToken.start,
    to,
  }
}

/**
 * 计算光标处的调用签名。
 *
 * 流水线：词法回看 → 定位未闭合调用括号 → 数活动形参 → 函数或方法装配。
 * 函数优先于方法：注册表里的名字即使与宿主方法同名（如 `at`），
 * 非点号调用时仍是函数调用。
 *
 * @returns 光标位于某个未闭合调用参数内时的签名；位于字符串、数组字面量、
 * 已闭合调用或非调用上下文时返回 null
 */
export function signatureHelp(context: SignatureContext): SignatureHelp | null {
  const offset = Math.max(0, Math.min(context.offset, context.text.length))

  let tokens
  try {
    tokens = tokenize(context.text.slice(0, offset))
  } catch {
    return null
  }

  const list = tokens.slice(0, -1)
  const openIndex = findUnclosedCall(list)
  const nameToken = openIndex > 0 ? list[openIndex - 1] : undefined
  if (!nameToken || nameToken.type !== 'name') return null

  const activeParameter = countActiveParameter(list, openIndex)

  const descriptor = context.functions.find((item) => item.name === nameToken.text)
  if (descriptor) return descriptorHelp(descriptor, nameToken, activeParameter, offset)

  const beforeName = openIndex > 1 ? list[openIndex - 2] : undefined
  const isMemberCall =
    beforeName?.type === 'punct' && (beforeName.text === '.' || beforeName.text === '?.')
  if (!isMemberCall) return null

  return methodHelp(nameToken, activeParameter, offset)
}
