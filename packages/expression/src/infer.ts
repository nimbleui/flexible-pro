import type { ExpressionNode, ValueTypeSchema } from '@lc/schema'
import type { BuiltinDoc } from './host'
import { BUILTIN_DOCS, methodReturnType } from './host'

/**
 * 表达式静态类型推断。
 *
 * 只服务编辑器：推断结果用于补全方法/字段，不参与求值。无法确定时返回
 * `unknown` 而不是抛错；`resolved` 用来区分「确实是 unknown 类型」和
 * 「字段/函数根本不存在」——前者补全可以宽松列出全部方法，后者应该空列表。
 */

export interface InferredType {
  /** 推断出的类型 */
  type: ValueTypeSchema
  /** 表达式是否锚定到了已知声明；false 表示路径/函数不存在 */
  resolved: boolean
}

/**
 * 静态推断的上下文配置。
 *
 * 全部可选项都允许缺省：编辑器上下文不完整时推断降级为 unknown，
 * 而不是报错 —— 推断结果只影响补全质量，不构成任何求值承诺。
 */
export interface InferOptions {
  /** 当前作用域变量类型；函数体里是形参，页面表达式里是 data/page/route */
  variables?: Readonly<Record<string, ValueTypeSchema>>
  /** 解析自定义函数返回类型；返回 undefined 表示函数不存在 */
  resolveFunction?: (name: string) => ValueTypeSchema | undefined
  /** 递归深度上限，兜住异常嵌套 @default 16 */
  maxDepth?: number
}

const UNKNOWN: ValueTypeSchema = { kind: 'unknown' }
const STRING: ValueTypeSchema = { kind: 'string' }
const NUMBER: ValueTypeSchema = { kind: 'number' }
const BOOLEAN: ValueTypeSchema = { kind: 'boolean' }

const BUILTIN_BY_NAME: ReadonlyMap<string, BuiltinDoc> = new Map(
  BUILTIN_DOCS.map((doc) => [doc.name, doc]),
)

function known(type: ValueTypeSchema): InferredType {
  return { type, resolved: true }
}

function unknown(resolved = true): InferredType {
  return { type: UNKNOWN, resolved }
}

function missing(): InferredType {
  return { type: UNKNOWN, resolved: false }
}

function itemOf(type: ValueTypeSchema): ValueTypeSchema {
  return type.item ?? UNKNOWN
}

function sameKind(a: InferredType, b: InferredType): InferredType {
  if (!a.resolved || !b.resolved) return missing()
  if (a.type.kind === b.type.kind) return known(a.type)
  return unknown()
}

/** 给箭头回调绑定元素类型；只用于 map 这类可推断结果的调用 */
function inferCallbackReturn(
  node: ExpressionNode | undefined,
  receiverItem: ValueTypeSchema,
  options: InferOptions,
  depth: number,
): ValueTypeSchema {
  if (!node || node.kind !== 'arrow') return UNKNOWN

  const variables: Record<string, ValueTypeSchema> = { ...(options.variables ?? {}) }
  if (node.params[0]) variables[node.params[0]] = receiverItem
  if (node.params[1]) variables[node.params[1]] = NUMBER

  return inferExpression(node.body, { ...options, variables }, depth + 1).type
}

/** 调用节点：callee 与实参列表的 AST 形态 */
type CallNode = Extract<ExpressionNode, { kind: 'call' }>

/** 具名调用：内置函数优先，其次是注册表里的自定义函数；两者都没有视为不存在 */
function inferNamedCall(name: string, options: InferOptions): InferredType {
  const builtin = BUILTIN_BY_NAME.get(name)
  if (builtin) return known(builtin.returns)

  const returns = options.resolveFunction?.(name)
  return returns ? known(returns) : missing()
}

/**
 * 数组方法的专用返回类型规则。
 *
 * 只覆盖结果依赖元素类型、通用方法表无法表达的调用（map/find/reduce 等）；
 * 表内其它数组方法返回 null，由调用方落到 `methodReturnType` 的通用结果。
 */
function inferArrayMethodCall(
  node: CallNode,
  method: string,
  receiverType: ValueTypeSchema,
  options: InferOptions,
  depth: number,
): InferredType | null {
  const item = itemOf(receiverType)

  if (method === 'map') {
    return known({
      kind: 'array',
      item: inferCallbackReturn(node.args[0], item, options, depth),
    })
  }
  if (method === 'filter' || method === 'sort' || method === 'slice' || method === 'reverse') {
    return known({ kind: 'array', item })
  }
  if (method === 'find' || method === 'at') {
    return known(item)
  }
  if (method === 'reduce') {
    return node.args[1]
      ? known(inferExpression(node.args[1], options, depth + 1).type)
      : unknown()
  }
  return null
}

function inferCall(node: CallNode, options: InferOptions, depth: number): InferredType {
  const { callee } = node

  if (callee.kind === 'identifier') return inferNamedCall(callee.name, options)

  if (callee.kind !== 'member') return missing()

  const receiver = inferExpression(callee.object, options, depth + 1)
  if (!receiver.resolved) return missing()

  const method = callee.property
  const kind = receiver.type.kind

  if (kind === 'array') {
    const special = inferArrayMethodCall(node, method, receiver.type, options, depth)
    if (special) return special
  }

  if (kind === 'string' || kind === 'number' || kind === 'array') {
    return methodReturnType(kind, method) ? known(methodReturnType(kind, method)!) : unknown()
  }

  // 类型未知时仍允许继续提示：调用结果按 unknown 处理
  if (kind === 'unknown') return unknown()

  // 对象/布尔没有宿主方法
  return missing()
}

/** 成员访问：对象字段可精确命中；数组/字符串的 length 恒为数字；其余视为路径不存在 */
function inferMemberType(
  node: Extract<ExpressionNode, { kind: 'member' }>,
  options: InferOptions,
  depth: number,
): InferredType {
  const base = inferExpression(node.object, options, depth + 1)
  if (!base.resolved) return missing()

  if (base.type.kind === 'object') {
    const field = base.type.fields?.[node.property]
    return field ? known(field) : missing()
  }

  if (
    (base.type.kind === 'array' || base.type.kind === 'string') &&
    node.property === 'length'
  ) {
    return known(NUMBER)
  }

  return missing()
}

/** 下标访问：数组给元素类型、字符串给字符；对象键无法静态确定，返回 unknown 而不是不存在 */
function inferIndexType(
  node: Extract<ExpressionNode, { kind: 'index' }>,
  options: InferOptions,
  depth: number,
): InferredType {
  const base = inferExpression(node.object, options, depth + 1)
  if (!base.resolved) return missing()

  if (base.type.kind === 'array') return known(itemOf(base.type))
  if (base.type.kind === 'string') return known(STRING)
  if (base.type.kind === 'object') return unknown()

  return missing()
}

/**
 * 二元运算结果类型。
 *
 * `+` 单独成规则：任一侧是字符串即拼接，两侧数字才做算术 —— 与求值器 `add`
 * 的分派一致，推断与求值在这里的口径必须相同，否则补全会指向错误的方法集。
 */
function inferBinaryType(
  node: Extract<ExpressionNode, { kind: 'binary' }>,
  options: InferOptions,
  depth: number,
): InferredType {
  const left = inferExpression(node.left, options, depth + 1)
  const right = inferExpression(node.right, options, depth + 1)

  if (node.op === '==' || node.op === '!=' || node.op === '===' || node.op === '!==') {
    return known(BOOLEAN)
  }
  if (node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=') {
    return known(BOOLEAN)
  }
  if (node.op === '+') {
    if (left.resolved && left.type.kind === 'string') return known(STRING)
    if (right.resolved && right.type.kind === 'string') return known(STRING)
    if (left.type.kind === 'number' && right.type.kind === 'number') return known(NUMBER)
    return left.resolved && right.resolved ? unknown() : missing()
  }
  if (left.type.kind === 'number' && right.type.kind === 'number') return known(NUMBER)
  return left.resolved && right.resolved ? unknown() : missing()
}

/** 数组字面量：元素类型只看首项，与求值行为无关，仅为补全提供近似提示 */
function inferArrayType(
  node: Extract<ExpressionNode, { kind: 'array' }>,
  options: InferOptions,
  depth: number,
): InferredType {
  const first = node.elements[0]
  const item = first ? inferExpression(first, options, depth + 1) : undefined
  return known({
    kind: 'array',
    ...(item?.resolved ? { item: item.type } : {}),
  })
}

/** 对象字面量：逐属性推断组成字段表；缺省字段一律按 unknown 保留 */
function inferObjectType(
  node: Extract<ExpressionNode, { kind: 'object' }>,
  options: InferOptions,
  depth: number,
): InferredType {
  const fields: Record<string, ValueTypeSchema> = {}
  for (const property of node.properties) {
    fields[property.key] = inferExpression(property.value, options, depth + 1).type
  }
  return known({ kind: 'object', fields })
}

/**
 * 推断一个表达式节点的静态类型。
 *
 * 按节点类别逐一分派；每个类别的规则拆在同名 `inferXxxType` 里，
 * 本函数保持「纯 dispatch」以便对照 AST 定义审阅覆盖面。
 *
 * @param node 表达式 AST
 * @param options 变量类型与自定义函数返回类型解析器
 * @param depth 内部递归深度，调用方不需要传
 */
export function inferExpression(
  node: ExpressionNode,
  options: InferOptions = {},
  depth = 0,
): InferredType {
  if (depth > (options.maxDepth ?? 16)) return missing()

  switch (node.kind) {
    case 'literal': {
      if (typeof node.value === 'string') return known(STRING)
      if (typeof node.value === 'number') return known(NUMBER)
      if (typeof node.value === 'boolean') return known(BOOLEAN)
      return missing()
    }

    case 'identifier': {
      const type = options.variables?.[node.name]
      return type ? known(type) : missing()
    }

    case 'member':
      return inferMemberType(node, options, depth)

    case 'index':
      return inferIndexType(node, options, depth)

    case 'call':
      return inferCall(node, options, depth)

    case 'unary':
      return known(node.op === '!' ? BOOLEAN : NUMBER)

    case 'binary':
      return inferBinaryType(node, options, depth)

    case 'logical':
      return sameKind(
        inferExpression(node.left, options, depth + 1),
        inferExpression(node.right, options, depth + 1),
      )

    case 'conditional':
      return sameKind(
        inferExpression(node.consequent, options, depth + 1),
        inferExpression(node.alternate, options, depth + 1),
      )

    case 'array':
      return inferArrayType(node, options, depth)

    case 'object':
      return inferObjectType(node, options, depth)

    case 'arrow':
      return missing()
  }
}
