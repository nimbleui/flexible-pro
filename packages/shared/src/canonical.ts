/**
 * 规范化 JSON 序列化。
 *
 * 存在理由：内容寻址要求「同一内容在任何设备、任何写入路径下得到同一字节」。
 * `JSON.stringify` 按对象键的插入顺序输出，而 `applyPatches` 的展开、`JSON.parse`
 * 回读、面板逐项提交会产生不同键序；不先规范化，内容相同的实体会算出不同地址，
 * diff 全是噪声，三方合并的快路径（`base === ours`）也永远不命中。
 *
 * 与 `json.ts` 的 `formatJsonValue` 分工：那个是给人看的缩进文本，保持原样。
 * 本模块只服务机器比较与 hash，不改变任何展示层输出。
 */

/**
 * 规范化时遇到无法无损表达的值。
 *
 * 用异常而不是静默降级：`JSON.stringify` 会把 `NaN` 写成 `null`、把数组里的
 * `undefined` 写成 `null`，等于在 hash 之前就悄悄改写了内容。
 */
export class CanonicalValueError extends TypeError {
  constructor(reason: string) {
    super(`无法规范化 JSON 值：${reason}`)
    this.name = 'CanonicalValueError'
  }
}

/**
 * 把任意 JSON 值规范化为字符串：对象键按 Unicode 码点升序、数组保序、`undefined` 键剔除。
 *
 * 数组保序是语义要求：`children` / `slots` / `actionIds` 的顺序代表视觉顺序与执行顺序，
 * 排序会把两个真实不同的版本算成同一个。数字走 `Number.toString` 最短路，`-0` 归一为 `0`。
 *
 * @param value 待规范化的值，必须是 JSON 可无损表达的数据
 * @returns 紧凑的规范化文本，可直接作为 `hashText` 的输入
 * @throws CanonicalValueError 顶层为 `undefined`、数组含 `undefined`、出现 `NaN` /
 * `Infinity` / 循环引用 / 类实例 / `bigint` / 函数 / `symbol` 时抛出
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new CanonicalValueError('顶层值不能是 undefined')

  return serialize(value, new Set<object>())
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return serializeNumber(value)
    case 'object':
      return serializeObject(value, ancestors)
    default:
      throw new CanonicalValueError(`不支持 ${typeof value} 类型`)
  }
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalValueError('NaN 与 Infinity 无法无损表达为 JSON 数字')
  }

  // -0 与 0 内容相等，若不归一，「0 改成 -0」会显示成两侧相同却 hash 不同
  if (Object.is(value, -0)) return '0'

  return String(value)
}

function serializeObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw new CanonicalValueError('存在循环引用')

  if (Array.isArray(value)) {
    ancestors.add(value)
    try {
      const items = value.map((item) => {
        if (item === undefined) throw new CanonicalValueError('数组元素不能是 undefined')
        return serialize(item, ancestors)
      })
      return `[${items.join(',')}]`
    } finally {
      ancestors.delete(value)
    }
  }

  // 类实例、Date、Map 等无法由键枚举无损还原，不猜它们的 toJSON 行为
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalValueError('只接受纯对象，类实例需先转成 JSON 数据')
  }

  ancestors.add(value)
  try {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort(compareByCodePoint)
    const entries: string[] = []

    for (const key of keys) {
      const item = record[key]
      // undefined 键剔除，与 arrayFieldPatch「清空即 remove 键」同口径
      if (item === undefined) continue
      entries.push(`${JSON.stringify(key)}:${serialize(item, ancestors)}`)
    }

    return `{${entries.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

/** 按 Unicode 码点比较，避免 UTF-16 码元排序让代理对字符与 BMP 字符错位。 */
function compareByCodePoint(left: string, right: string): number {
  const a = Array.from(left)
  const b = Array.from(right)
  const length = Math.min(a.length, b.length)

  for (let index = 0; index < length; index += 1) {
    const diff = (a[index].codePointAt(0) ?? 0) - (b[index].codePointAt(0) ?? 0)
    if (diff !== 0) return diff
  }

  return a.length - b.length
}
