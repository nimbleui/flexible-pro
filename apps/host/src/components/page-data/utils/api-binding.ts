import type { PageApiBinding, PageSchema, ProjectApi, SchemaPatch } from '@lc/schema'
import { applyApiBindings, arrayFieldPatch, stripApiBindings } from '@lc/schema'
import { isValidFunctionName } from '@lc/expression'

/**
 * 页面引用项目接口时的两件纯逻辑：绑定名建议、以及一次绑定改动要打的补丁。
 *
 * 单独成模块是因为这两件事都有明确的对错判据却没有组件可以承载：绑定名必须是合法标识符
 * 且不与既有数据项重名，补丁必须同时改到 `apis` 与 `datasources`——少打一条，画布上的
 * 表现就是「已经引用了但取不到数」或「解绑了数据源还赖在列表里」。
 */

/** 建议名推不出来时的兜底名 */
const FALLBACK_NAME = 'apiData'

/**
 * 从接口定义推一个默认绑定名。
 *
 * 取路径最后一个真实段（`{id}` 这类占位段不算），把连字符与下划线拼成驼峰：
 * `/orders/{id}` → `orders`、`/order-items` → `orderItems`。接口名多是中文，
 * 直接拿来做 `data.<名>` 会撞上标识符规则，所以路径才是更稳的名字来源。
 *
 * @param api 接口定义
 * @param taken 已被占用的数据项名（变量、数据源、其他绑定）
 * @returns 未被占用的合法名字；冲突时追加序号
 */
export function suggestBindingName(api: ProjectApi, taken: ReadonlySet<string>): string {
  const base = camelNameOf(api.path) || camelNameOf(api.id) || FALLBACK_NAME
  if (!taken.has(base)) return base

  let index = 2
  while (taken.has(`${base}${index}`)) index += 1

  return `${base}${index}`
}

/** 路径或 id → 驼峰名；得到非法标识符时返回空串，由调用方决定下一个候选 */
function camelNameOf(raw: string): string {
  const withoutQuery = raw.split(/[?#]/)[0] ?? ''
  const segments = withoutQuery
    .split('/')
    .filter((segment) => segment !== '' && !segment.startsWith('{') && !segment.startsWith(':'))

  const last = segments[segments.length - 1] ?? ''
  const camel = last
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== '')
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('')

  if (camel === '' || /^\d/.test(camel)) return ''

  return isValidFunctionName(camel) ? camel : ''
}

/**
 * 一次绑定改动要打的补丁。
 *
 * 两条一起出：`apis` 是落盘的真相，`datasources` 是画布此刻该看到的内容。只改前者的话，
 * 新引用要等页面重新装载才出现；只改后者的话，写回时会被 `stripApiBindings` 剥掉，
 * 等于没绑。展开与剥离都复用 `@lc/schema` 里那两个函数，判据只有装载路径那一套。
 *
 * @param schema 文档内存态（`datasources` 里可能已经带着旧绑定展开出的条目）
 * @param nextBindings 改动后的完整绑定列表
 * @param apis 该项目名下的接口表
 * @returns 按顺序交给文档服务的两条补丁
 */
export function bindingPatches(
  schema: PageSchema,
  nextBindings: readonly PageApiBinding[],
  apis: readonly ProjectApi[],
): SchemaPatch[] {
  // 先按旧绑定剥掉展开结果，再按新绑定展开：否则解绑一次会留下一条没人要的数据源
  const locals = stripApiBindings(schema).datasources ?? []
  const expanded = applyApiBindings(
    {
      ...schema,
      apis: [...nextBindings],
      datasources: locals.length === 0 ? undefined : locals,
    },
    apis,
  )

  return [
    arrayFieldPatch('apis', schema.apis, nextBindings),
    arrayFieldPatch('datasources', schema.datasources, expanded.datasources ?? []),
  ]
}
