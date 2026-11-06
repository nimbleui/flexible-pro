/**
 * 出码运行时片段。
 *
 * 生成代码里的 `const $rt = { ... }` 逐条对应 `@lc/expression` 的 coercion、内置函数
 * 与 `@lc/schema` 文档里的数据转换步骤。之所以要复制一份而不是 import 平台包：
 * 出码的用途是脱离平台独立运行，把 `@lc/expression` 拖进产物等于没出码。
 *
 * 代价是这份实现必须与平台同步演进，所以每个成员都注明了它的平台侧出处。
 */

/** 运行时成员名 → 成员源码（已按对象字面量的两级缩进书写） */
const RUNTIME_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  // 出处：packages/expression/src/coerce.ts toNumber
  num: [
    '  num: (value) => {',
    "    if (typeof value === 'number') return value",
    "    if (typeof value === 'boolean') return value ? 1 : 0",
    "    if (typeof value === 'string') return Number(value)",
    '    if (value === null) return 0',
    '    if (value === undefined) return Number.NaN',
    "    throw new TypeError('不能把 ' + typeof value + ' 当成数字参与运算')",
    '  }',
  ],

  // 出处：coerce.ts toDisplayString —— null 与 undefined 转空串，不是 "null"
  str: ["  str: (value) => (value === null || value === undefined ? '' : String(value))"],

  // 出处：coerce.ts toBoolean
  bool: ['  bool: (value) => Boolean(value)'],

  // 出处：host.ts 内置函数 stringify
  json: ['  json: (value) => JSON.stringify(value ?? null)'],

  // 出处：coerce.ts isPlainRecord —— 只有裸对象才算「有结构的数据」
  plain: [
    '  plain: (value) => {',
    "    if (value === null || typeof value !== 'object') return false",
    '    const proto = Object.getPrototypeOf(value)',
    '    return proto === Object.prototype || proto === null',
    '  }',
  ],

  // 出处：coerce.ts isEmptyValue
  isEmpty: [
    '  isEmpty: (value) => {',
    '    if (value === null || value === undefined) return true',
    "    if (typeof value === 'string') return value.length === 0",
    '    if (Array.isArray(value)) return value.length === 0',
    '    if (value instanceof Map || value instanceof Set) return value.size === 0',
    '    if ($rt.plain(value)) return Object.keys(value).length === 0',
    '    return false',
    '  }',
  ],

  // 出处：coerce.ts isBlankValue
  isBlank: [
    '  isBlank: (value) =>',
    "    typeof value === 'string' ? value.trim().length === 0 : $rt.isEmpty(value)",
  ],

  // 出处：host.ts numericArgs —— 数组摊平后逐项转数字
  nums: [
    '  nums: (values) => {',
    '    const numbers = []',
    '    for (const value of values) {',
    '      if (Array.isArray(value)) {',
    '        for (const item of value) numbers.push($rt.num(item))',
    '        continue',
    '      }',
    '      numbers.push($rt.num(value))',
    '    }',
    "    if (numbers.length === 0) throw new TypeError('该函数至少需要一个数值参数')",
    '    return numbers',
    '  }',
  ],

  abs: ['  abs: (n) => Math.abs($rt.num(n))'],
  round: ['  round: (n) => Math.round($rt.num(n))'],
  floor: ['  floor: (n) => Math.floor($rt.num(n))'],
  ceil: ['  ceil: (n) => Math.ceil($rt.num(n))'],
  min: ['  min: (...values) => Math.min(...$rt.nums(values))'],
  max: ['  max: (...values) => Math.max(...$rt.nums(values))'],

  // 出处：schema/datasource.ts PathTransform —— 点路径取子字段
  path: [
    '  path: (value, dotted) =>',
    '    String(dotted)',
    "      .split('.')",
    '      .reduce(',
    '        (current, key) => (current === null || current === undefined ? undefined : current[key]),',
    '        value,',
    '      )',
  ],

  pick: [
    '  pick: (value, fields) =>',
    '    Object.fromEntries(',
    '      fields.filter((field) => field in Object(value)).map((field) => [field, value[field]]),',
    '    )',
  ],

  omit: [
    '  omit: (value, fields) =>',
    '    Object.fromEntries(',
    '      Object.entries(Object(value)).filter(([key]) => !fields.includes(key)),',
    '    )',
  ],

  // 出处：datasource.ts SortTransform —— by 既可能是字段路径也可能是表达式，出码统一成取键函数
  compare: [
    "  compare: (a, b, order) => (a < b ? -1 : a > b ? 1 : 0) * (order === 'desc' ? -1 : 1)",
  ],

  dedupe: [
    '  dedupe: (value, by) => {',
    '    const seen = new Set()',
    '    return value.filter((item) => {',
    '      const key = by ? $rt.path(item, by) : item',
    '      if (seen.has(key)) return false',
    '      seen.add(key)',
    '      return true',
    '    })',
    '  }',
  ],

  groupBy: [
    '  groupBy: (value, by) =>',
    '    value.reduce((groups, item) => {',
    '      const key = String($rt.path(item, by))',
    '      ;(groups[key] ??= []).push(item)',
    '      return groups',
    '    }, {})',
  ],

  // 出处：datasource.ts TransformConfig —— 十种步骤按声明顺序串成管道
  step: [
    '  step: (value, step) => {',
    '    if (value === null || value === undefined) return value',
    '    switch (step.kind) {',
    "      case 'path': return $rt.path(value, step.path)",
    "      case 'pick': return Array.isArray(value) ? value.map((item) => $rt.pick(item, step.fields)) : $rt.pick(value, step.fields)",
    "      case 'omit': return Array.isArray(value) ? value.map((item) => $rt.omit(item, step.fields)) : $rt.omit(value, step.fields)",
    "      case 'map': return Array.isArray(value) ? value.map(step.fn) : value",
    "      case 'filter': return Array.isArray(value) ? value.filter(step.fn) : value",
    "      case 'sort': return Array.isArray(value) ? [...value].sort((a, b) => $rt.compare(step.key(a), step.key(b), step.order)) : value",
    "      case 'flatten': return Array.isArray(value) ? value.flat(step.depth ?? 1) : value",
    "      case 'dedupe': return Array.isArray(value) ? $rt.dedupe(value, step.by) : value",
    "      case 'groupBy': return Array.isArray(value) ? $rt.groupBy(value, step.by) : value",
    "      case 'expression': return step.fn(value)",
    '      default: return value',
    '    }',
    '  }',
  ],

  apply: [
    '  apply: (value, steps) => steps.reduce((current, step) => $rt.step(current, step), value)',
  ],
}

/** 成员之间的依赖：用到 min 就必须连 nums 和 num 一起落进产物 */
const RUNTIME_DEPS: Readonly<Record<string, readonly string[]>> = {
  abs: ['num'],
  round: ['num'],
  floor: ['num'],
  ceil: ['num'],
  min: ['nums'],
  max: ['nums'],
  nums: ['num'],
  isEmpty: ['plain'],
  isBlank: ['isEmpty', 'plain'],
  step: ['path', 'pick', 'omit', 'compare', 'dedupe', 'groupBy'],
  apply: ['step'],
  dedupe: ['path'],
  groupBy: ['path'],
}

/** 展开依赖闭包；顺序固定，产物文本才能可 diff */
function resolveNeeds(needs: Iterable<string>): string[] {
  const resolved = new Set<string>()

  function visit(name: string): void {
    if (resolved.has(name)) return
    resolved.add(name)
    for (const dependency of RUNTIME_DEPS[name] ?? []) visit(dependency)
  }

  for (const name of [...needs].sort()) visit(name)
  return [...resolved].sort()
}

/**
 * 生成 `const $rt = { ... }` 代码块。
 *
 * @returns 没有任何运行时依赖时返回空数组，产物里连这段注释都不该出现
 */
export function emitRuntime(needs: Iterable<string>): string[] {
  const names = resolveNeeds(needs).filter((name) => RUNTIME_MEMBERS[name] !== undefined)
  if (names.length === 0) return []

  // 每项都带尾逗号：增删一条成员时 diff 只动一行
  const members = names.map((name) => `${RUNTIME_MEMBERS[name].join('\n')},`).join('\n')

  return [
    '/**',
    ' * 出码运行时：白名单表达式的 coercion、内置函数与数据转换管道。',
    ' * 逐条对应平台侧 @lc/expression 与 schema 协议文档，改一边不改另一边会让',
    ' * 「设计期看到的结果」和「出码后跑出来的结果」分叉。',
    ' */',
    'const $rt = {',
    members,
    '}',
  ]
}
