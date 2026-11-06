import type { PageSchema } from '@lc/schema'
import { PAGE_EVENT_SOURCE } from '@lc/schema'
import type { CodegenContext, ExpressionCompiler, MaterialImportResolver } from './context'
import { createCodegenContext } from './context'
import { emitScript } from './emit-script'
import { emitMarkup } from './emit-template'

export type { ExpressionCompiler, MaterialImportResolver } from './context'

/** 出码输入 */
export interface CodegenInput {
  /** 页面 schema */
  schema: PageSchema
  /** 文件头注释里的页面名 */
  pageTitle: string
  /** 物料名 → 可导入包名 */
  resolveImport: MaterialImportResolver
  /** 表达式编译器 */
  compile: ExpressionCompiler
}

/** 出码产物 */
export interface GeneratedCode {
  /** 单文件组件文本 */
  code: string
  /**
   * 出码过程中的降级与提醒。
   *
   * 面板必须把它们显示出来：静默降级会让用户以为产物和页面完全等价，
   * 而「物料没登记导入来源」这类问题只有在复制走之后才会暴露。
   */
  warnings: readonly string[]
}

/** 节点 id → 该节点上已绑定的事件名；出码不含动作链，模板里留一条注释说明去向 */
function collectNodeEvents(schema: PageSchema): Map<string, string[]> {
  const map = new Map<string, string[]>()

  for (const connection of Object.values(schema.connections ?? {})) {
    if (connection.sourceNodeId === PAGE_EVENT_SOURCE) continue

    const names = map.get(connection.sourceNodeId)
    if (names) {
      if (!names.includes(connection.eventName)) names.push(connection.eventName)
    } else {
      map.set(connection.sourceNodeId, [connection.eventName])
    }
  }

  return map
}

/**
 * 把页面 schema 出码成一份 Vue 3 单文件组件。
 *
 * 覆盖范围：节点结构与几何、属性绑定、条件 / 循环 / 指令、变量与接口数据、
 * 数据转换管道、页面声明式函数与内置函数运行时。
 *
 * 不覆盖：事件动作链（由平台运行时按 `connections` 执行，模板里留注释标明）、
 * 数据源缓存策略。两条都在 warnings 里说清楚，不做静默降级。
 */
export function generatePageSfc(input: CodegenInput): GeneratedCode {
  const { schema, pageTitle, resolveImport, compile } = input
  const ctx: CodegenContext = createCodegenContext({ compile, resolveImport })

  const markup = emitMarkup({ schema, eventsByNode: collectNodeEvents(schema) }, ctx)
  const script = emitScript(schema, ctx)

  const code = [
    header(pageTitle, ctx),
    '<template>',
    ...markup.lines,
    '</template>',
    '',
    '<script setup>',
    ...script.lines,
    '</script>',
    '',
    '<style scoped>',
    ...markup.styles,
    `/* 未映射物料的占位框样式，与画布上的虚线占位同一视觉 */`,
    '.lc-unresolved {',
    '  display: flex;',
    '  width: 100%;',
    '  height: 100%;',
    '  align-items: center;',
    '  justify-content: center;',
    '  border: 1px dashed currentColor;',
    '  opacity: 0.6;',
    '}',
    '</style>',
    '',
  ].join('\n')

  return { code, warnings: ctx.warnings }
}

/** 文件头：来源、覆盖范围与降级项都写在这里，产物离开平台后仍然能自解释 */
function header(pageTitle: string, ctx: CodegenContext): string {
  const lines = [
    '<!--',
    `  由低代码平台出码生成 · 页面：${pageTitle}`,
    '  结构：每个节点一个定位 wrapper，物料组件是其第一个子元素，children 与之并列。',
    '  范围：事件动作链与数据源缓存不在出码内，前者由平台运行时按 connections 执行。',
  ]

  if (ctx.warnings.length > 0) {
    lines.push('')
    lines.push('  本次出码的降级项：')
    for (const warning of ctx.warnings) lines.push(`  - ${warning}`)
  }

  lines.push('-->')
  return lines.join('\n')
}
