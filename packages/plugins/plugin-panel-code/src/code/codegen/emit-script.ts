import type { FunctionSchema, PageSchema } from '@lc/schema'
import type { CodegenContext } from './context'
import { RESERVED_BINDINGS, warn } from './context'
import { emitDataSource, fetchNameOf } from './emit-datasource'
import { emitExpression } from './emit-expression'
import { emitJsonLiteral, isIdentifier, memberKey, pascalName, quote } from './naming'
import { emitRuntime } from './runtime'

/** 脚本段产物；vue 的 import 已经在第一行里 */
export interface EmittedScript {
  /** `<script setup>` 段逐行文本，已含 vue import 与物料 / 状态 / 数据源 / 运行时拼装 */
  lines: string[]
}

/** 函数体允许两种承载形式，出码时都要能吃下 */
function emitFunctionBody(body: FunctionSchema['body'], ctx: CodegenContext): string {
  if (typeof body === 'string') return emitExpression(body, 'expression', ctx).js
  return emitExpression(body.raw, 'expression', ctx).js
}

/** 包名 → 名字表局部别名；一个页面用到多个组件库时不会互相盖掉 */
function aliasOf(importSource: string): string {
  const cleaned = importSource.replace(/^@/u, '').replace(/[/.]/gu, '-')
  return `${pascalName(cleaned)}Components`
}

/** 物料 import：按包分组，一个包一条语句 + 每个物料一行查表 */
function emitMaterialImports(ctx: CodegenContext): string[] {
  const byPackage = new Map<string, { componentName: string; tag: string }[]>()

  for (const [componentName, tag] of ctx.components) {
    const importSource = ctx.componentSource.get(componentName)
    if (!importSource) continue

    const entries = byPackage.get(importSource)
    if (entries) entries.push({ componentName, tag })
    else byPackage.set(importSource, [{ componentName, tag }])
  }

  const lines: string[] = []
  for (const [importSource, entries] of [...byPackage.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    const alias = aliasOf(importSource)
    lines.push(`import { components as ${alias} } from ${quote(importSource)}`)

    for (const entry of entries.sort((a, b) => (a.tag < b.tag ? -1 : 1))) {
      lines.push(`const ${entry.tag} = ${alias}[${quote(entry.componentName)}]`)
    }
    lines.push('')
  }

  return lines
}

/**
 * 未映射物料的占位组件。
 *
 * 与画布上的虚线占位框同一语义：产物仍然是合法 Vue 组件，页面能跑起来，
 * 接入真实组件库后只需替换这一段定义，不必改模板。
 */
function emitPlaceholders(ctx: CodegenContext): string[] {
  if (ctx.unresolvedMaterials.size === 0) return []

  const lines = [
    '/**',
    ' * 未登记可导入包的物料占位实现。',
    ' * 与画布上的虚线占位框同一语义：接入真实组件库后替换这一段即可，模板不必改。',
    ' */',
  ]

  for (const componentName of [...ctx.unresolvedMaterials].sort()) {
    const tag = ctx.components.get(componentName)
    if (!tag) continue
    lines.push(`const ${tag} = {`)
    lines.push(`  name: ${quote(tag)},`)
    lines.push('  inheritAttrs: false,')
    lines.push('  render() {')
    lines.push(`    return h('div', { class: 'lc-unresolved' }, ${quote(componentName)})`)
    lines.push('  },')
    lines.push('}')
    lines.push('')
  }

  return lines
}

function emitState(schema: PageSchema): string[] {
  const variables = schema.variables ?? []
  const lines = ['/** 页面变量：初值取声明里的 defaultValue */', 'const state = reactive({']

  for (const variable of variables) {
    // 变量名允许 `data` 这类与内置名字撞车的形式：作为对象键完全合法，不必让位
    const key = isIdentifier(variable.name) ? variable.name : quote(variable.name)
    lines.push(`  ${key}: ${emitJsonLiteral(variable.defaultValue)},`)
  }

  lines.push('})')
  return lines
}

function emitSources(
  schema: PageSchema,
  ctx: CodegenContext,
): {
  lines: string[]
  fetches: string[]
  mounts: string[]
  timers: string[]
} {
  const sources = schema.datasources ?? []
  const lines = [
    '/** 接口数据状态：与运行时 DataSourceState 同构，结果在 .data */',
    'const sources = reactive({',
  ]
  const fetches: string[] = []
  const mounts: string[] = []
  const timers: string[] = []

  for (const source of sources) {
    const emitted = emitDataSource(source, ctx)
    lines.push(`  ${memberKey(emitted.id)}: ${emitted.initial},`)
    if (emitted.fetch.length > 0) {
      fetches.push(...emitted.fetch, '')
      if (emitted.autoFetch) mounts.push(`  void ${fetchNameOf(source.id)}()`)
      if (emitted.pollingMs > 0) {
        mounts.push(
          `  timers.push(window.setInterval(() => void ${fetchNameOf(source.id)}(), ${emitted.pollingMs}))`,
        )
        timers.push('  for (const timer of timers) window.clearInterval(timer)')
      }
    }
  }

  lines.push('})')
  return { lines, fetches, mounts, timers }
}

function emitFunctions(schema: PageSchema, ctx: CodegenContext): string[] {
  const functions = schema.functions ?? []
  if (functions.length === 0) return []

  const lines: string[] = ['/** 页面声明式函数：与表达式里调用到的名字一一对应 */']

  for (const fn of functions) {
    if (RESERVED_BINDINGS.has(fn.name)) {
      warn(
        ctx,
        `页面函数 ${fn.name} 与出码脚本的内置名字冲突，产物里跳过它的定义；请改名后重新出码。`,
      )
      continue
    }

    // 形参名在函数体内本来就先于外层作用域，撞了内置名字也只是局部遮蔽，不用改写
    const params = fn.params ?? []
    lines.push(`function ${fn.name}(${params.join(', ')}) {`)
    lines.push(`  return ${emitFunctionBody(fn.body, ctx)}`)
    lines.push('}')
    lines.push('')
  }

  return lines
}

/**
 * 出码 `<script setup>` 段。
 *
 * 顶层名字固定为 `data` / `page` / `event` / `state` / `sources` / `$rt` / `$route`
 * 这一组，与 `buildExpressionScope` 装配出来的作用域同形。刻意不做标识符改写：
 * 表达式原文怎么写，产物里就怎么写，这样「面板里看到的表达式」和「产物里的表达式」
 * 是同一串文本，出码才有可核对性。
 */
export function emitScript(schema: PageSchema, ctx: CodegenContext): EmittedScript {
  // state / sources / data 三段恒定存在，所以 reactive 与 computed 不需要按条件加
  const vueImports = new Set<string>(['computed', 'reactive'])
  const materialImports = emitMaterialImports(ctx)
  const placeholders = emitPlaceholders(ctx)
  const sources = emitSources(schema, ctx)
  const functions = emitFunctions(schema, ctx)
  const runtime = emitRuntime(ctx.runtimeNeeds)

  if (placeholders.length > 0) vueImports.add('h')
  if (sources.mounts.length > 0) vueImports.add('onMounted')
  if (sources.timers.length > 0) vueImports.add('onUnmounted')

  const lines: string[] = [
    `import { ${[...vueImports].sort().join(', ')} } from 'vue'`,
    '',
    ...materialImports,
    ...placeholders,
    ...emitState(schema),
    '',
    ...sources.lines,
  ]

  if (sources.fetches.length > 0) lines.push('', ...sources.fetches)

  lines.push(
    '',
    '/**',
    ' * 表达式作用域里的 data：变量与接口数据共用这一个命名空间，变量覆盖同名数据源。',
    ' * 与运行时 buildPageData 同构，所以表达式原文在设计器和产物里读到的是同一棵树。',
    ' */',
    'const data = computed(() => ({ ...sources, ...state }))',
    '',
    `const page = ${emitJsonLiteral(schema.metadata ?? {})}`,
    '',
    '/** 事件参数：出码不含动作链，渲染期恒为空对象 */',
    'const event = {}',
    '',
    '/** 宿主路由注入；接入 vue-router 时把这三行换成 useRoute() 的结果 */',
    "const $route = { path: '/', params: {}, query: {} }",
    'const $params = $route.params',
    'const $query = $route.query',
  )

  if (functions.length > 0) lines.push('', ...functions)
  if (runtime.length > 0) lines.push('', ...runtime, '')

  if (sources.mounts.length > 0) {
    lines.push('const timers = []')
    lines.push('')
    lines.push('onMounted(() => {')
    lines.push(...sources.mounts)
    lines.push('})')
  }

  if (sources.timers.length > 0) {
    lines.push('')
    lines.push('onUnmounted(() => {')
    lines.push(...sources.timers)
    lines.push('})')
  }

  return { lines }
}
