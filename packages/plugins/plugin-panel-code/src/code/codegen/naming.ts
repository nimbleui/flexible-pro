/** 出码用到的命名规则；集中一处，模板与脚本两侧才不会拼出两个不同的类名 */

/** 节点 id 到 CSS 类名；id 里的非法字符换成 `-`，选择器才不会解析失败 */
export function nodeClass(nodeId: string): string {
  return `node-${nodeId.replace(/[^A-Za-z0-9_-]/gu, '-')}`
}

/**
 * 物料名到 `<script setup>` 里的局部变量名。
 *
 * 物料名允许 `agile-plus.switch` 这种带点与小写的形式，既不是合法标识符也可能与
 * 其他物料重名，所以要清洗后再按来源包加前缀去重。
 */
export function componentVar(componentName: string, importSource: string): string {
  const base = pascalName(componentName.split('.').pop() ?? componentName)
  const owner = pascalName(namespaceOf(importSource))
  // 已经以命名空间开头的物料名（`agile-plus.switch` → Switch）不再重复加前缀
  return base.startsWith(owner) ? base : `${owner}${base}`
}

/** 包名最后一段作为命名空间；`@lc/plugin-materials-basic` → `plugin-materials-basic` */
function namespaceOf(importSource: string): string {
  return importSource.split('/').pop() ?? importSource
}

/** 连字符 / 点 / 下划线分词后首字母大写 */
export function pascalName(value: string): string {
  const words = value.split(/[^A-Za-z0-9]+/u).filter(Boolean)
  if (words.length === 0) return 'Lc'
  return words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join('')
}

/** 数据源 id 到取数函数名：`loadUsers` */
export function fetchFunctionName(sourceId: string): string {
  return `load${pascalName(sourceId)}`
}

/** 是否可以直接当 JS 标识符用；页面函数名与循环形参都要过这一关 */
export function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/u.test(value)
}

/** 属性名在模板里能不能裸写；带 `-` 的自定义属性必须引号包裹 */
export function attrName(name: string): string {
  return isIdentifier(name) ? name : JSON.stringify(name)
}

/**
 * 字符串 → JS 单引号字面量。
 *
 * 产物统一用单引号，与仓库的 prettier 配置一致；串里本身带单引号时退回
 * `JSON.stringify` 的双引号形态，避免为了统一风格去手写转义规则。
 */
export function quote(value: string): string {
  if (value.includes("'")) return JSON.stringify(value)
  const escaped = value
    .replace(/\\/gu, '\\\\')
    .replace(/\n/gu, '\\n')
    .replace(/\r/gu, '\\r')
    .replace(/\t/gu, '\\t')
  return `'${escaped}'`
}

/** 成员访问的键：合法标识符走 `sources.users`，其余才退回 `sources['a-b']` */
export function memberKey(name: string): string {
  return isIdentifier(name) ? name : quote(name)
}

/**
 * JSON 值 → 单行 JS 对象字面量。
 *
 * 不用 `JSON.stringify`：那会给每个键套上引号，产物里出现 `{ "url": "x" }`
 * 这种既不好读也不好改的文本。合法标识符的键裸写，其余仍用引号兜住。
 */
export function emitJsonLiteral(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'string') return quote(value)
  if (typeof value !== 'object') return String(value)

  if (Array.isArray(value)) return `[${value.map((item) => emitJsonLiteral(item)).join(', ')}]`

  const pairs = Object.entries(value as Record<string, unknown>).map(
    ([key, item]) => `${isIdentifier(key) ? key : quote(key)}: ${emitJsonLiteral(item)}`,
  )
  return `{ ${pairs.join(', ')} }`
}

/**
 * 模板属性值里的 JS 文本做 HTML 转义。
 *
 * 出码直译会产生 `foo('a')` 这类带引号的 JS，而模板绑定统一写成 `:p="…"`；
 * 转义而不是改用单引号，是因为 JS 侧的单引号同样可能出现在字符串里。
 */
export function escapeAttr(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;')
}
