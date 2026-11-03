import type { ValueTypeSchema } from '@lc/schema'
import { ExpressionError } from './errors'
import { isEmptyValue, isBlankValue, toBoolean, toDisplayString, toNumber } from './coerce'

/**
 * 表达式可访问的外部能力：属性黑名单、按接收者类型划分的方法白名单、内置函数表。
 *
 * 安全性的**主**防线不是下面的黑名单，而是求值器从不走原型链：
 * 属性读取只认自有数据属性，方法调用只认这张白名单表。
 * 黑名单是补刀 —— 设计文档 §19.8 点名禁止 `constructor`，
 * 而数据字段里确实可能出现同名键（某些后端会序列化它），
 * 显式拒绝比「依赖它恰好不是自有属性」更可论证。
 */

/** 无论是否为自有属性都拒绝读取的键 */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
])

/**
 * 一次宿主方法声明。
 *
 * `callbackArgs` 标注哪些实参位需要把语法树里的箭头函数换成真正可调用的回调。
 * 转换必须由求值器完成（它才拿得到作用域帧），所以这里只做声明式标注。
 */
export interface HostMethod {
  /** 调用实现；receiver 是接收者原值，args 为已求值实参（回调位已换成 JS 函数） */
  readonly apply: (receiver: unknown, args: readonly unknown[]) => unknown
  /** 需要做箭头函数→回调转换的实参位置下标；缺省表示无回调位 */
  readonly callbackArgs?: readonly number[]
}

type MethodTable = ReadonlyMap<string, HostMethod>

/**
 * 宿主方法收到的回调形参。
 *
 * 实参在传进来之前已由求值器把语法树里的箭头函数换成 JS 函数，
 * 这里只做类型收口，不做运行时判定 —— 判定失败的情况求值器已经先报错了。
 */
type ArrayCallback = (value: unknown, index: number, array: unknown[]) => unknown
type ReduceCallback = (
  accumulator: unknown,
  value: unknown,
  index: number,
  array: unknown[],
) => unknown

function callbackAt(args: readonly unknown[], position = 0): ArrayCallback {
  return args[position] as ArrayCallback
}

const FIRST_ARG_CALLBACK = [0] as const

/** 数组方法表；除 `sort` / `reverse` 外均为原生语义 */
const ARRAY_METHODS: MethodTable = new Map<string, HostMethod>([
  [
    'map',
    {
      apply: (receiver, args) =>
        Array.prototype.map.call(receiver as unknown[], callbackAt(args)),
      callbackArgs: FIRST_ARG_CALLBACK,
    },
  ],
  [
    'filter',
    {
      apply: (receiver, args) =>
        Array.prototype.filter.call(receiver as unknown[], callbackAt(args)),
      callbackArgs: FIRST_ARG_CALLBACK,
    },
  ],
  [
    'find',
    {
      apply: (receiver, args) =>
        Array.prototype.find.call(receiver as unknown[], callbackAt(args)),
      callbackArgs: FIRST_ARG_CALLBACK,
    },
  ],
  [
    'findIndex',
    {
      apply: (receiver, args) =>
        Array.prototype.findIndex.call(receiver as unknown[], callbackAt(args)),
      callbackArgs: FIRST_ARG_CALLBACK,
    },
  ],
  [
    'some',
    {
      apply: (receiver, args) =>
        Array.prototype.some.call(receiver as unknown[], callbackAt(args)),
      callbackArgs: FIRST_ARG_CALLBACK,
    },
  ],
  [
    'every',
    {
      apply: (receiver, args) =>
        Array.prototype.every.call(receiver as unknown[], callbackAt(args)),
      callbackArgs: FIRST_ARG_CALLBACK,
    },
  ],
  [
    'reduce',
    {
      // 必须按实参个数分支：`reduce(cb, undefined)` 与 `reduce(cb)` 的首个累加值不同
      apply: (receiver, args) => {
        const list = receiver as unknown[]
        const callback = args[0] as ReduceCallback
        return args.length > 1 ? list.reduce(callback, args[1]) : list.reduce(callback)
      },
      callbackArgs: FIRST_ARG_CALLBACK,
    },
  ],
  [
    'sort',
    {
      // 排序不改动原数组：表达式被 schema 声明为纯函数（见 schema/functions.ts），
      // 就地排序会让同一个列表在两次渲染之间顺序不同。
      apply: (receiver, args) => [...(receiver as unknown[])].sort(args[0] as Comparator),
      callbackArgs: FIRST_ARG_CALLBACK,
    },
  ],
  ['includes', { apply: (receiver, args) => (receiver as unknown[]).includes(args[0]) }],
  ['indexOf', { apply: (receiver, args) => (receiver as unknown[]).indexOf(args[0]) }],
  [
    'join',
    {
      apply: (receiver, args) =>
        (receiver as unknown[]).join(args[0] === undefined ? ',' : toDisplayString(args[0])),
    },
  ],
  [
    'slice',
    {
      apply: (receiver, args) =>
        (receiver as unknown[]).slice(
          asIndex(args[0], 0),
          args[1] === undefined ? undefined : asIndex(args[1], 0),
        ),
    },
  ],
  [
    'concat',
    { apply: (receiver, args) => (receiver as unknown[]).concat(...(args as unknown[])) },
  ],
  ['at', { apply: (receiver, args) => (receiver as unknown[]).at(asIndex(args[0], 0)) }],
  [
    'flat',
    {
      apply: (receiver, args) =>
        (receiver as unknown[]).flat(args[0] === undefined ? 1 : asIndex(args[0], 1)),
    },
  ],
  ['reverse', { apply: (receiver) => [...(receiver as unknown[])].reverse() }],
])

/** 字符串方法表；`replace` / `replaceAll` 只接受字符串模式，语言里没有正则字面量 */
const STRING_METHODS: MethodTable = new Map<string, HostMethod>([
  ['charAt', { apply: (receiver, args) => (receiver as string).charAt(asIndex(args[0], 0)) }],
  [
    'slice',
    {
      apply: (receiver, args) =>
        (receiver as string).slice(
          asIndex(args[0], 0),
          args[1] === undefined ? undefined : asIndex(args[1], 0),
        ),
    },
  ],
  [
    'split',
    { apply: (receiver, args) => (receiver as string).split(toDisplayString(args[0] ?? '')) },
  ],
  ['trim', { apply: (receiver) => (receiver as string).trim() }],
  ['trimStart', { apply: (receiver) => (receiver as string).trimStart() }],
  ['trimEnd', { apply: (receiver) => (receiver as string).trimEnd() }],
  ['toLowerCase', { apply: (receiver) => (receiver as string).toLowerCase() }],
  ['toUpperCase', { apply: (receiver) => (receiver as string).toUpperCase() }],
  [
    'indexOf',
    { apply: (receiver, args) => (receiver as string).indexOf(toDisplayString(args[0])) },
  ],
  [
    'includes',
    { apply: (receiver, args) => (receiver as string).includes(toDisplayString(args[0])) },
  ],
  [
    'startsWith',
    { apply: (receiver, args) => (receiver as string).startsWith(toDisplayString(args[0])) },
  ],
  [
    'endsWith',
    { apply: (receiver, args) => (receiver as string).endsWith(toDisplayString(args[0])) },
  ],
  [
    'padStart',
    {
      apply: (receiver, args) =>
        (receiver as string).padStart(asIndex(args[0], 0), toDisplayString(args[1] ?? ' ')),
    },
  ],
  [
    'padEnd',
    {
      apply: (receiver, args) =>
        (receiver as string).padEnd(asIndex(args[0], 0), toDisplayString(args[1] ?? ' ')),
    },
  ],
  ['repeat', { apply: (receiver, args) => (receiver as string).repeat(asIndex(args[0], 0)) }],
  [
    'replace',
    {
      apply: (receiver, args) =>
        (receiver as string).replace(toDisplayString(args[0]), toDisplayString(args[1] ?? '')),
    },
  ],
  [
    'replaceAll',
    {
      apply: (receiver, args) =>
        (receiver as string).replaceAll(
          toDisplayString(args[0]),
          toDisplayString(args[1] ?? ''),
        ),
    },
  ],
  ['at', { apply: (receiver, args) => (receiver as string).at(asIndex(args[0], 0)) }],
])

/** 数字方法表 */
const NUMBER_METHODS: MethodTable = new Map<string, HostMethod>([
  [
    'toFixed',
    {
      apply: (receiver, args) =>
        (receiver as number).toFixed(args[0] === undefined ? 0 : asIndex(args[0], 0)),
    },
  ],
  [
    'toPrecision',
    {
      apply: (receiver, args) =>
        (receiver as number).toPrecision(
          args[0] === undefined ? undefined : asIndex(args[0], 1),
        ),
    },
  ],
])

type Comparator = (a: unknown, b: unknown) => number

/** 索引/长度类参数：非数字一律按 0 处理，避免 `slice(undefined)` 产出 NaN 语义 */
function asIndex(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return fallback
}

/** 方法表所属的接收者类型；编辑器补全按它分组展示方法 */
export type HostReceiverType = 'array' | 'string' | 'number'

const METHOD_TABLES: Readonly<Record<HostReceiverType, MethodTable>> = {
  array: ARRAY_METHODS,
  string: STRING_METHODS,
  number: NUMBER_METHODS,
}

/** 按接收者的运行时类型取方法表；取不到即该类型不支持任何方法调用 */
export function resolveMethodTable(receiver: unknown): MethodTable | undefined {
  if (Array.isArray(receiver)) return ARRAY_METHODS
  if (typeof receiver === 'string') return STRING_METHODS
  if (typeof receiver === 'number') return NUMBER_METHODS
  return undefined
}

/**
 * 列出某一接收者类型支持的全部方法名。
 *
 * 补全与文档表必须直接消费这份行为表，而不是另抄一份方法名；
 * `editor.spec.ts` 会校验两边完全一致。
 */
export function listHostMethods(type: HostReceiverType): readonly string[] {
  return [...METHOD_TABLES[type].keys()]
}

const UNKNOWN_TYPE: ValueTypeSchema = { kind: 'unknown' }
const STRING_TYPE: ValueTypeSchema = { kind: 'string' }
const NUMBER_TYPE: ValueTypeSchema = { kind: 'number' }
const BOOLEAN_TYPE: ValueTypeSchema = { kind: 'boolean' }
const ARRAY_TYPE: ValueTypeSchema = { kind: 'array' }
const STRING_ARRAY_TYPE: ValueTypeSchema = { kind: 'array', item: STRING_TYPE }

/**
 * 方法返回类型表。
 *
 * 只描述静态可推断的返回类型；`map` / `filter` / `reduce` 这类依赖回调的
 * 结果由 `infer.ts` 结合实参进一步细化，这里给出保守形态。
 */
const METHOD_RETURNS: Readonly<
  Record<HostReceiverType, Readonly<Record<string, ValueTypeSchema>>>
> = {
  array: {
    map: ARRAY_TYPE,
    filter: ARRAY_TYPE,
    find: UNKNOWN_TYPE,
    findIndex: NUMBER_TYPE,
    some: BOOLEAN_TYPE,
    every: BOOLEAN_TYPE,
    reduce: UNKNOWN_TYPE,
    sort: ARRAY_TYPE,
    includes: BOOLEAN_TYPE,
    indexOf: NUMBER_TYPE,
    join: STRING_TYPE,
    slice: ARRAY_TYPE,
    concat: ARRAY_TYPE,
    at: UNKNOWN_TYPE,
    flat: ARRAY_TYPE,
    reverse: ARRAY_TYPE,
  },
  string: {
    charAt: STRING_TYPE,
    slice: STRING_TYPE,
    split: STRING_ARRAY_TYPE,
    trim: STRING_TYPE,
    trimStart: STRING_TYPE,
    trimEnd: STRING_TYPE,
    toLowerCase: STRING_TYPE,
    toUpperCase: STRING_TYPE,
    indexOf: NUMBER_TYPE,
    includes: BOOLEAN_TYPE,
    startsWith: BOOLEAN_TYPE,
    endsWith: BOOLEAN_TYPE,
    padStart: STRING_TYPE,
    padEnd: STRING_TYPE,
    repeat: STRING_TYPE,
    replace: STRING_TYPE,
    replaceAll: STRING_TYPE,
    at: STRING_TYPE,
  },
  number: {
    toFixed: STRING_TYPE,
    toPrecision: STRING_TYPE,
  },
}

/** 取方法返回类型；未收录的方法返回 undefined，由调用方降级为 unknown */
export function methodReturnType(
  receiver: HostReceiverType,
  method: string,
): ValueTypeSchema | undefined {
  return METHOD_RETURNS[receiver][method]
}

/** 内置函数；`expression` 参数只用于把错误文案定位到具体表达式 */
export type BuiltinFunction = (args: readonly unknown[], expression: string) => unknown

/**
 * 内置函数表。
 *
 * 收录标准只有一条：**语言表达不了的能力**。`list.length`、`a + b`、
 * `list.filter(t => t.done).length` 都能直接写，因此不设 `len` / `sum` / `avg`；
 * 其余业务向函数交给 `FunctionSchema` 由使用者自己声明，
 * 避免每来一个需求就往引擎里塞一个全局名。
 */
export const BUILTIN_FUNCTIONS: ReadonlyMap<string, BuiltinFunction> = new Map<
  string,
  BuiltinFunction
>([
  ['abs', (args, expression) => Math.abs(toNumber(args[0], expression))],
  ['min', (args, expression) => Math.min(...numericArgs(args, expression))],
  ['max', (args, expression) => Math.max(...numericArgs(args, expression))],
  ['round', (args, expression) => Math.round(toNumber(args[0], expression))],
  ['floor', (args, expression) => Math.floor(toNumber(args[0], expression))],
  ['ceil', (args, expression) => Math.ceil(toNumber(args[0], expression))],
  ['number', (args, expression) => toNumber(args[0], expression)],
  ['string', (args) => toDisplayString(args[0])],
  ['boolean', (args) => toBoolean(args[0])],
  ['stringify', (args) => JSON.stringify(args[0] ?? null)],
  ['isEmpty', (args) => isEmptyValue(args[0])],
  ['isBlank', (args) => isBlankValue(args[0])],
])

/** 内置函数名集合；注册自定义函数时用它拒绝覆盖全局语义 */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set(BUILTIN_FUNCTIONS.keys())

/** 内置函数的展示元数据；与 BUILTIN_FUNCTIONS 一一对应（由测试保证） */
export interface BuiltinDoc {
  /** 注册名；必须与 BUILTIN_FUNCTIONS 的键一一对应 */
  readonly name: string
  /** 中文标题，用于补全与参考面板 */
  readonly title: string
  /** 展示用形参；`...` 前缀表示可变参数 */
  readonly params: readonly string[]
  /** 参考面板说明文案；与实现行为保持同步（由测试校验存在性） */
  readonly description: string
  /** 静态返回类型，用于表达式推断 */
  readonly returns: ValueTypeSchema
}

/** 内置函数文档；顺序即参考面板的展示顺序 */
export const BUILTIN_DOCS: readonly BuiltinDoc[] = [
  {
    name: 'abs',
    title: '绝对值',
    params: ['n'],
    description: '返回数值的绝对值。',
    returns: NUMBER_TYPE,
  },
  {
    name: 'min',
    title: '最小值',
    params: ['...values'],
    description: '返回最小值，支持 min(a, b) 或 min(list)。',
    returns: NUMBER_TYPE,
  },
  {
    name: 'max',
    title: '最大值',
    params: ['...values'],
    description: '返回最大值，支持 max(a, b) 或 max(list)。',
    returns: NUMBER_TYPE,
  },
  {
    name: 'round',
    title: '四舍五入',
    params: ['n'],
    description: '四舍五入到整数。',
    returns: NUMBER_TYPE,
  },
  {
    name: 'floor',
    title: '向下取整',
    params: ['n'],
    description: '向下取整。',
    returns: NUMBER_TYPE,
  },
  {
    name: 'ceil',
    title: '向上取整',
    params: ['n'],
    description: '向上取整。',
    returns: NUMBER_TYPE,
  },
  {
    name: 'number',
    title: '转数字',
    params: ['value'],
    description: '把值转换为数字。',
    returns: NUMBER_TYPE,
  },
  {
    name: 'string',
    title: '转字符串',
    params: ['value'],
    description: '把值转换为字符串。',
    returns: STRING_TYPE,
  },
  {
    name: 'boolean',
    title: '转布尔',
    params: ['value'],
    description: '把值转换为布尔值。',
    returns: BOOLEAN_TYPE,
  },
  {
    name: 'stringify',
    title: '序列化',
    params: ['value'],
    description: '把值序列化成 JSON 字符串。',
    returns: STRING_TYPE,
  },
  {
    name: 'isEmpty',
    title: '是否为空',
    params: ['value'],
    description: '判断空数组、空字符串、null 或 undefined。',
    returns: BOOLEAN_TYPE,
  },
  {
    name: 'isBlank',
    title: '是否空白',
    params: ['value'],
    description: '判断空字符串或只包含空白字符的字符串。',
    returns: BOOLEAN_TYPE,
  },
]

/**
 * 把实参摊平成数字数组：`min(1, 5)` 与 `min([1, 5])` 都成立。
 * 设计器里两种写法都会出现，只认一种会变成「函数存在但报参数错误」的困惑。
 *
 * @throws ExpressionError kind 为 `invalid-operand`
 */
function numericArgs(args: readonly unknown[], expression: string): number[] {
  const numbers: number[] = []

  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (const item of arg) numbers.push(toNumber(item, expression))
      continue
    }
    numbers.push(toNumber(arg, expression))
  }

  if (numbers.length === 0) {
    throw new ExpressionError('invalid-operand', '该函数至少需要一个数值参数', expression)
  }

  return numbers
}
