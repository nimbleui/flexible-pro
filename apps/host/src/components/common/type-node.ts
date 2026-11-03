import type { ValueTypeKind, ValueTypeSchema } from '@lc/schema'
import { valueTypeFromSample, valueTypeToSample } from '@lc/expression/editor'

/**
 * 结构化类型编辑草稿。
 *
 * 与 `ValueTypeSchema` 的区别是带输入框需要的文本值：
 * 叶节点的示例/默认值、字段说明；对象字段与数组元素递归。
 */
export interface TypeNodeDraft {
  /** 字段名；根节点或数组元素允许为空 */
  name: string
  /**
   * 类型种类；切换它不会搬运已填内容，
   * 因此切走再切回对象/数组时字段列表仍在，由提交时的 `valueTypeFromTypeNode` 决定哪些生效。
   */
  kind: ValueTypeKind
  /** 字段说明 */
  description: string
  /** 叶节点的示例值文本 */
  valueText: string
  /** 对象字段 */
  fields: TypeNodeDraft[]
  /** 数组元素类型；非数组时可为 undefined */
  item: TypeNodeDraft | undefined
  /** 保留样本推导出的可选/可空标记 */
  optional: boolean
  /** 值是否可能为 null；与 `optional` 互不蕴含，编辑器分两个开关展示 */
  nullable: boolean
}

/** 可引用的已定义类型；选中时复制结构，后续可继续局部修改 */
export interface NamedTypeOption {
  /** 稳定 id，如 `variable:profile`、`datasource:users`、`param:fn:list` */
  id: string
  /** 下拉展示名 */
  label: string
  /** 类型结构；引用时深拷贝，候选本身不被编辑 */
  type: ValueTypeSchema
  /** 可选的示例值，用于回显字段值 */
  sample?: unknown
}

/** 类型下拉的候选；顺序即展示顺序，与 ValueTypeKind 全集一致（unknown 排在首位作兜底） */
export const TYPE_KIND_OPTIONS: ReadonlyArray<{
  /** 选项值，直接写入草稿的 `kind` */
  value: ValueTypeKind
  /** 下拉展示文案 */
  label: string
}> = [
  { value: 'unknown', label: '未知类型' },
  { value: 'string', label: '字符串' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔' },
  { value: 'array', label: '数组' },
  { value: 'object', label: '对象' },
]

/**
 * 判断类型是否为叶子节点。
 *
 * 编辑器据此决定显示示例值输入框还是字段/元素列表；`unknown` 也算叶子，
 * 因为它的字段结构尚未推导出来，此时仍然只有一行输入可用。
 */
export function isLeafKind(kind: ValueTypeKind): boolean {
  return kind !== 'object' && kind !== 'array'
}

/** 生成一个空白草稿；除 name/kind 外全部取空值，避免调用方各自记忆默认形状 */
export function createTypeNode(name = '', kind: ValueTypeKind = 'unknown'): TypeNodeDraft {
  return {
    name,
    kind,
    description: '',
    valueText: '',
    fields: [],
    item: undefined,
    optional: false,
    nullable: false,
  }
}

/** 深拷贝类型草稿；编辑器会递归增删字段，不能与 initial 共享引用 */
export function cloneTypeNode(node: TypeNodeDraft): TypeNodeDraft {
  return {
    ...node,
    fields: node.fields.map(cloneTypeNode),
    item: node.item ? cloneTypeNode(node.item) : undefined,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatValueText(kind: ValueTypeKind, value: unknown): string {
  if (value === undefined) return ''
  if (kind === 'string') return typeof value === 'string' ? value : String(value)
  if (kind === 'number') return typeof value === 'number' ? String(value) : ''
  if (kind === 'boolean') return typeof value === 'boolean' ? String(value) : ''
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? ''
}

/** 把 schema 类型 + 示例值转成可编辑草稿；sample 用来回显已有值 */
export function typeNodeFromValueType(
  name: string,
  type: ValueTypeSchema,
  sample?: unknown,
): TypeNodeDraft {
  const node = createTypeNode(name, type.kind)
  node.description = type.description ?? ''
  node.optional = type.optional === true
  node.nullable = type.nullable === true

  if (isLeafKind(type.kind)) {
    node.valueText = formatValueText(type.kind, sample)
    return node
  }

  if (type.kind === 'object') {
    node.fields = Object.entries(type.fields ?? {}).map(([key, child]) =>
      typeNodeFromValueType(key, child, isPlainObject(sample) ? sample[key] : undefined),
    )
    return node
  }

  node.item = typeNodeFromValueType(
    '',
    type.item ?? { kind: 'unknown' },
    Array.isArray(sample) ? sample[0] : undefined,
  )
  return node
}

/**
 * 从示例值反推类型草稿，用于「只有数据、没有类型声明」的场景。
 *
 * 推导只看结构不看语义，结果可能偏宽（例如全空的数组只能得到 unknown 元素），
 * 所以返回的是可继续编辑的草稿而不是最终类型。
 */
export function typeNodeFromSample(name: string, sample: unknown): TypeNodeDraft {
  return typeNodeFromValueType(name, valueTypeFromSample(sample), sample)
}

function parseTextValue(kind: ValueTypeKind, text: string): unknown {
  if (kind === 'string') return text
  if (kind === 'number') {
    const value = Number(text)
    return text.trim() === '' || !Number.isFinite(value) ? undefined : value
  }
  if (kind === 'boolean') {
    if (text === 'true') return true
    if (text === 'false') return false
    return undefined
  }

  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return text
  }
}

/** 草稿转 schema 类型；空字段名忽略，重名保留第一条 */
export function valueTypeFromTypeNode(node: TypeNodeDraft): ValueTypeSchema {
  const type: ValueTypeSchema = { kind: node.kind }

  const description = node.description.trim()
  if (description !== '') type.description = description
  if (node.optional) type.optional = true
  if (node.nullable) type.nullable = true

  if (node.kind === 'object') {
    const fields: Record<string, ValueTypeSchema> = {}
    for (const field of node.fields) {
      const name = field.name.trim()
      if (name === '' || fields[name]) continue
      fields[name] = valueTypeFromTypeNode(field)
    }
    type.fields = fields
  }

  if (node.kind === 'array') {
    type.item = valueTypeFromTypeNode(node.item ?? createTypeNode('', 'unknown'))
  }

  return type
}

/** 用草稿里的示例值生成运行时/mock 数据；对象字段与数组元素递归 */
export function sampleFromTypeNode(node: TypeNodeDraft): unknown {
  if (node.kind === 'object') {
    const sample: Record<string, unknown> = {}
    for (const field of node.fields) {
      const name = field.name.trim()
      if (name === '') continue
      sample[name] = sampleFromTypeNode(field)
    }
    return sample
  }

  if (node.kind === 'array') {
    if (!node.item) return []
    const value = sampleFromTypeNode(node.item)
    return value === undefined ? [] : [value]
  }

  return parseTextValue(node.kind, node.valueText)
}

/** 试跑输入的一格解析结果；`error` 非空表示文本与声明类型不符，此时 value 为 undefined */
export interface ParsedTypeInput {
  /** 可以绑进求值作用域的值 */
  value: unknown
  /** 需要展示给用户的错误文案；解析成功时不出现该键 */
  error?: string
}

/**
 * 按声明类型严格解析一格试跑实参。
 *
 * 口径与 `sampleFromTypeNode` 不同：后者服务于 mock 数据，宽松到可以把非法 JSON 降级成字符串；
 * 试跑如果照这个宽松口径传值，函数体报错会指向表达式而不是输入框。因此数字/布尔/对象/数组
 * 要求与声明一致，空文本一律视为「不传该实参」。
 *
 * @param kind 形参声明的类型种类
 * @param text 输入框文本
 * @returns 解析出的值，或需要展示给用户的错误文案
 */
export function parseTypeInput(kind: ValueTypeKind, text: string): ParsedTypeInput {
  if (kind === 'string') return { value: text }
  if (text.trim() === '') return { value: undefined }

  const value = parseTextValue(kind, text)

  if ((kind === 'number' || kind === 'boolean') && value === undefined) {
    const error = kind === 'number' ? '请填写合法数字' : '请填写 true 或 false'
    return { value: undefined, error }
  }

  if (kind === 'object' || kind === 'array') {
    const matches = kind === 'array' ? Array.isArray(value) : isPlainObject(value)
    if (!matches) {
      const error = kind === 'array' ? '请填写合法 JSON 数组' : '请填写合法 JSON 对象'
      return { value: undefined, error }
    }
  }

  return { value }
}

/**
 * 生成试跑输入框的初始文本。
 *
 * 叶子取草稿里已填的示例值；对象与数组按声明结构生成 JSON 骨架 ——
 * `sampleFromTypeNode` 的空叶子是 undefined，直接 stringify 会让整块字段消失，
 * 用户只能看到一个空对象而不知道该填哪些键。
 */
export function inputTextFromTypeNode(node: TypeNodeDraft): string {
  if (isLeafKind(node.kind)) return node.valueText
  return JSON.stringify(valueTypeToSample(valueTypeFromTypeNode(node))) ?? ''
}
