import type { ExpressionNode } from '@lc/schema'
import { parseExpressionSource } from '../parser'
import { splitTemplate, unwrapBraces } from '../source'

/**
 * 表达式引用了作用域里的哪个位置。
 *
 * 只描述「引用了谁」，不描述「怎么算」：绑定面板据此把一条 `data.users.data`
 * 反查回它所属的数据项，并判断这个名字到底声明没有。
 */
export interface ExpressionRef {
  /** 根标识符名，如 `data`、`$params`、`event`、循环形参名 */
  root: string
  /**
   * 静态可确定的点路径，根在首位，如 `data.users.data`。
   *
   * 数组下标折成一段，所以 `data.list[0]` 记作 `data.list.0`；面板按前缀匹配
   * 时把它当作 `data.list` 的子路径即可，不必再解析一次。
   */
  path: string
  /**
   * 路径是否在动态下标处截断，如 `data.list[i].name` 只到 `data.list`。
   *
   * 截断不代表引用无效，只代表再往下的段名不属于静态路径，不能拿去做存在性校验。
   */
  dynamic: boolean
}

/** 引用提取的输入形态 */
export type RefTextMode =
  /** 整段是一个表达式，允许带 `{{ }}` 外壳：属性整值绑定、条件、循环源 */
  | 'expression'
  /** 混排文本，只提取 `{{ ... }}` 内部：提示文案、动作 config 里的字符串 */
  | 'template'

/** 一条静态访问链；`truncated` 表示链在动态下标处断掉 */
interface AccessChain {
  /** 静态可确定的路径段，根标识符在首位 */
  segments: string[]
  /** 链是否因动态下标而提前结束 */
  truncated: boolean
}

/** 下标只可能是字符串 / 数字字面量才算静态；其余一律视为动态 */
function literalKey(node: ExpressionNode): string | undefined {
  if (node.kind !== 'literal') return undefined
  const { value } = node
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

/**
 * 读取以本节点为终点的最长静态访问链。
 *
 * 链一旦在动态下标处截断就不再累加后续段名：`data.list[i].name` 里的 `name`
 * 落在哪一项上取决于 `i`，把它写成 `data.list.name` 会让存在性校验误报。
 *
 * @returns 不是访问链时返回 undefined，调用方转而遍历子节点
 */
function readChain(node: ExpressionNode): AccessChain | undefined {
  switch (node.kind) {
    case 'identifier':
      return { segments: [node.name], truncated: false }

    case 'member': {
      const base = readChain(node.object)
      if (!base || base.truncated) return undefined
      return { segments: [...base.segments, node.property], truncated: false }
    }

    case 'index': {
      const base = readChain(node.object)
      if (!base || base.truncated) return undefined

      const key = literalKey(node.index)
      if (key === undefined) return { segments: base.segments, truncated: true }
      return { segments: [...base.segments, key], truncated: false }
    }

    default:
      return undefined
  }
}

/**
 * 收集一棵子树里的全部引用。
 *
 * 命中一条完整链后不再深入它自己的子节点，否则 `data.users.data` 会连带产出
 * `data.users` 与 `data` 两条前缀，反查列表会把毫不相干的数据项也列进来。
 * 截断链例外：它自己的下标表达式仍是独立引用，必须继续走。
 */
function collect(node: ExpressionNode, refs: ExpressionRef[]): void {
  if (node.kind === 'call') {
    // 方法调用的接收者是数据引用，但方法名不是路径段：`list.map(f)` 引用的是 list。
    // 裸标识符 callee 记录成引用而不是跳过：内置与自定义函数都按名字从注册表或
    // 作用域取，「这个函数有没有被用到」和「这个变量有没有被读到」是同一件事。
    const { callee } = node
    if (callee.kind === 'member') collect(callee.object, refs)
    else collect(callee, refs)

    for (const arg of node.args) collect(arg, refs)
    return
  }

  const chain = readChain(node)
  if (chain) {
    refs.push({
      root: chain.segments[0] ?? '',
      path: chain.segments.join('.'),
      dynamic: chain.truncated,
    })
    if (chain.truncated && node.kind === 'index') collect(node.index, refs)
    return
  }

  for (const child of childrenOf(node)) collect(child, refs)
}

/** 语法树各节点的子节点；call 与「已经成链的访问」都在 collect 里单独处理 */
function childrenOf(node: ExpressionNode): readonly ExpressionNode[] {
  switch (node.kind) {
    case 'member':
      return [node.object]

    case 'index':
      return [node.object, node.index]

    case 'unary':
      return [node.argument]

    case 'binary':
    case 'logical':
      return [node.left, node.right]

    case 'conditional':
      return [node.test, node.consequent, node.alternate]

    case 'array':
      return node.elements

    case 'object':
      return node.properties.map((property) => property.value)

    case 'arrow':
      return [node.body]

    default:
      return []
  }
}

/**
 * 提取一段文本引用到的作用域路径。
 *
 * 语法错误在这里不是结论而是「取不到引用」：诊断由 `diagnoseExpression` 负责，
 * 本函数只保证不抛错，绑定面板因此可以先列引用再单独标红语法。
 *
 * @param text 表达式或模板文本
 * @param mode 输入形态，见 {@link RefTextMode}
 * @returns 去重后的引用列表，按首次出现顺序
 */
export function listExpressionRefs(
  text: string,
  mode: RefTextMode = 'expression',
): ExpressionRef[] {
  const sources =
    mode === 'template'
      ? splitTemplate(text)
          .filter((segment) => segment.kind === 'expression')
          .map((segment) => segment.text)
      : [unwrapBraces(text)]

  const refs: ExpressionRef[] = []
  for (const source of sources) {
    let ast: ExpressionNode
    try {
      ast = parseExpressionSource(source)
    } catch {
      continue
    }
    collect(ast, refs)
  }

  const seen = new Set<string>()
  return refs.filter((ref) => {
    if (seen.has(ref.path)) return false
    seen.add(ref.path)
    return true
  })
}
