import type { CodegenContext } from './context'
import { warn } from './context'
import { pascalName } from './naming'

/** 一个物料在生成代码里的落点 */
export interface MaterialBinding {
  /** 模板标签名，同时是 `<script setup>` 里的局部变量名 */
  tag: string
  /** 导入来源；缺省表示平台没有登记可导入的包，产物里生成占位组件 */
  importSource?: string
}

/**
 * 解析物料标签名并登记到上下文。
 *
 * 幂等：同一物料第二次解析拿到同一个标签，所以模板里可以随便调用，
 * 脚本侧的 import 语句仍只有一条。
 *
 * 物料名允许 `agile-plus.switch` 这种既不是标识符、末段又可能互相撞名的形式，
 * 因此标签由「末段 Pascal 化 + 已用集合去重」得到，而不是直接用物料名。
 */
export function resolveMaterialTag(
  componentName: string,
  ctx: CodegenContext,
): MaterialBinding {
  const cached = ctx.components.get(componentName)
  const importSource = ctx.resolveImport(componentName)

  if (cached) {
    return importSource === undefined ? { tag: cached } : { tag: cached, importSource }
  }

  const tag = uniqueTag(pascalName(componentName.split('.').pop() ?? componentName), ctx)
  ctx.components.set(componentName, tag)

  if (importSource) {
    ctx.componentSource.set(componentName, importSource)
    return { tag, importSource }
  }

  ctx.unresolvedMaterials.add(componentName)
  warn(
    ctx,
    `物料 ${componentName} 没有登记可导入的包，产物里用同名占位组件代替，接入真实组件库后需替换。`,
  )
  return { tag }
}

/** 已用标签集合：先按名字取，撞了就追加序号 */
function uniqueTag(base: string, ctx: CodegenContext): string {
  const used = new Set(ctx.components.values())
  if (!used.has(base)) return base

  let index = 2
  while (used.has(`${base}${index}`)) index += 1
  return `${base}${index}`
}
