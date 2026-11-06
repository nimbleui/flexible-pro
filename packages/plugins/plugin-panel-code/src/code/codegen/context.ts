import type { ExpressionAst } from '@lc/schema'

/**
 * 语法树编译器。
 *
 * 生产上就是 `(source) => ctx.expression.compile(source).ast`；出码只需要语法树，
 * 不需要求值、注册表与缓存，所以契约收窄到这一个函数，单元测试可以直接传闭包。
 */
export type ExpressionCompiler = (source: string) => ExpressionAst

/** 物料名 → 可导入的 ESM 包名；返回 undefined 表示该物料没有可导入的包 */
export type MaterialImportResolver = (componentName: string) => string | undefined

/** 一次出码的共享上下文 */
export interface CodegenContext {
  compile: ExpressionCompiler
  resolveImport: MaterialImportResolver
  /** 生成代码实际用到的 `$rt` 成员名；决定运行时块里落哪几条 */
  runtimeNeeds: Set<string>
  /** 物料名 → `<script setup>` 里的局部变量名 */
  components: Map<string, string>
  /** 物料名 → 实际落到产物里的导入来源；脚本侧按包分组生成 import */
  componentSource: Map<string, string>
  /** 没有可导入包、退化成占位组件的物料名 */
  unresolvedMaterials: Set<string>
  /** 出码过程中的降级与提醒，面板原样展示 */
  warnings: string[]
}

/** 与 schema 协议冲突的脚本顶层名字；出码时让位并给出警告 */
export const RESERVED_BINDINGS: ReadonlySet<string> = new Set([
  'data',
  'page',
  'event',
  'state',
  'sources',
  '$rt',
  '$route',
  '$params',
  '$query',
])

export function createCodegenContext(input: {
  compile: ExpressionCompiler
  resolveImport: MaterialImportResolver
}): CodegenContext {
  return {
    compile: input.compile,
    resolveImport: input.resolveImport,
    runtimeNeeds: new Set<string>(),
    components: new Map<string, string>(),
    componentSource: new Map<string, string>(),
    unresolvedMaterials: new Set<string>(),
    warnings: [],
  }
}

/** 追加一条去重后的警告；同一条原因不该在面板里刷屏 */
export function warn(ctx: CodegenContext, message: string): void {
  if (!ctx.warnings.includes(message)) ctx.warnings.push(message)
}
