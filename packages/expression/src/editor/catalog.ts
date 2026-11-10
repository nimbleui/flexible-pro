import type { HostReceiverType } from '../host'

/**
 * 宿主方法的展示元数据。
 *
 * 方法名必须与 `host.ts` 的行为表完全一致，由 `editor.spec.ts` 做双向校验；
 * 这里只放签名和说明，不会进入求值路径。
 */
export interface MethodDoc {
  /** 方法名；必须与 host.ts 行为表一致（editor.spec.ts 双向校验） */
  readonly name: string
  /** 展示用签名，不含接收者 */
  readonly signature: string
  /** 详情面板文案；与原生语义的偏差（如 sort 不改原数组）必须写明 */
  readonly description: string
}

/** 接收者类型的中文名，用于补全分组与详情 */
export const RECEIVER_LABELS: Readonly<Record<HostReceiverType, string>> = {
  array: '数组',
  string: '字符串',
  number: '数字',
}

/** 可直接读取的自有属性文档；属性不受方法白名单约束，但补全需要单独列出 */
export interface PropertyDoc {
  /** 属性名；只列自有语义的属性，方法不进这张表 */
  readonly name: string
  /** 可挂载该属性的接收者类型；补全时按变量类型收窄 */
  readonly receivers: readonly HostReceiverType[]
  /** 属性含义与单位（如 length 的单位是元素个数/字符数） */
  readonly description: string
}

/** 可直接读取的自有属性文档表；供补全列出属性（方法走 `METHOD_DOCS`），内容不进入求值路径 */
export const PROPERTY_DOCS: readonly PropertyDoc[] = [
  {
    name: 'length',
    receivers: ['array', 'string'],
    description: '数组元素个数或字符串字符数。',
  },
]

/** 按接收者类型分组的方法文档 */
export const METHOD_DOCS: Readonly<Record<HostReceiverType, readonly MethodDoc[]>> = {
  array: [
    { name: 'map', signature: 'map(fn)', description: '返回每个元素经 fn 处理后的新数组。' },
    {
      name: 'filter',
      signature: 'filter(fn)',
      description: '返回 fn 为真的元素组成的新数组。',
    },
    { name: 'find', signature: 'find(fn)', description: '返回第一个满足条件的元素。' },
    {
      name: 'findIndex',
      signature: 'findIndex(fn)',
      description: '返回第一个满足条件的元素下标，找不到为 -1。',
    },
    { name: 'some', signature: 'some(fn)', description: '是否存在满足条件的元素。' },
    { name: 'every', signature: 'every(fn)', description: '是否所有元素都满足条件。' },
    {
      name: 'reduce',
      signature: 'reduce(fn, initial?)',
      description: '从左到右累积；提供初始值时类型不受元素类型限制。',
    },
    {
      name: 'sort',
      signature: 'sort(compareFn?)',
      description: '返回排序后的新数组，不修改原数组。',
    },
    { name: 'includes', signature: 'includes(value)', description: '是否包含某个值。' },
    { name: 'indexOf', signature: 'indexOf(value)', description: '返回下标，找不到为 -1。' },
    {
      name: 'join',
      signature: 'join(separator?)',
      description: '用分隔符拼接成字符串，默认逗号。',
    },
    { name: 'slice', signature: 'slice(start?, end?)', description: '截取区间，返回新数组。' },
    {
      name: 'concat',
      signature: 'concat(...items)',
      description: '拼接数组或值，返回新数组。',
    },
    { name: 'at', signature: 'at(index)', description: '按下标取值，支持负数。' },
    { name: 'flat', signature: 'flat(depth?)', description: '展平嵌套数组，默认一层。' },
    {
      name: 'reverse',
      signature: 'reverse()',
      description: '返回反转后的新数组，不修改原数组。',
    },
  ],
  string: [
    { name: 'charAt', signature: 'charAt(index)', description: '返回指定位置的字符。' },
    { name: 'slice', signature: 'slice(start?, end?)', description: '截取子串。' },
    { name: 'split', signature: 'split(separator)', description: '按分隔符切分成数组。' },
    { name: 'trim', signature: 'trim()', description: '去掉首尾空白。' },
    { name: 'trimStart', signature: 'trimStart()', description: '去掉开头空白。' },
    { name: 'trimEnd', signature: 'trimEnd()', description: '去掉结尾空白。' },
    { name: 'toLowerCase', signature: 'toLowerCase()', description: '转小写。' },
    { name: 'toUpperCase', signature: 'toUpperCase()', description: '转大写。' },
    {
      name: 'indexOf',
      signature: 'indexOf(search)',
      description: '返回子串首次出现的位置，找不到为 -1。',
    },
    { name: 'includes', signature: 'includes(search)', description: '是否包含子串。' },
    {
      name: 'startsWith',
      signature: 'startsWith(prefix)',
      description: '是否以指定前缀开头。',
    },
    { name: 'endsWith', signature: 'endsWith(suffix)', description: '是否以指定后缀结尾。' },
    {
      name: 'padStart',
      signature: 'padStart(length, fill?)',
      description: '在开头补足到指定长度。',
    },
    {
      name: 'padEnd',
      signature: 'padEnd(length, fill?)',
      description: '在结尾补足到指定长度。',
    },
    { name: 'repeat', signature: 'repeat(count)', description: '重复指定次数。' },
    {
      name: 'replace',
      signature: 'replace(search, replacement)',
      description: '替换第一个匹配。',
    },
    {
      name: 'replaceAll',
      signature: 'replaceAll(search, replacement)',
      description: '替换全部匹配。',
    },
    { name: 'at', signature: 'at(index)', description: '按下标取字符，支持负数。' },
  ],
  number: [
    {
      name: 'toFixed',
      signature: 'toFixed(digits?)',
      description: '保留指定小数位，返回字符串。',
    },
    {
      name: 'toPrecision',
      signature: 'toPrecision(precision?)',
      description: '保留指定有效数字，返回字符串。',
    },
  ],
}
