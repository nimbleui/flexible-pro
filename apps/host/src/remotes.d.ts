/**
 * 远程画布模块的类型声明。
 *
 * 画布由 `apps/designer` 以 Module Federation 暴露，模块地址在运行时才确定，
 * 所以这里手写边界类型而不是依赖构建产物：props 就是 host 与 remote 的契约，
 * 改它等同于改 exposes。
 *
 * 本文件不能出现顶层 import：否则它变成普通模块，`declare module` 会被当作
 * 对不存在模块的增强而报错。
 */
declare module 'designerCanvas/CanvasModule' {
  import type { DefineComponent } from 'vue'
  import type { CanvasContext } from '@lc/contracts'
  import type { Context } from '@lc/kernel'

  const CanvasModule: DefineComponent<{
    /** 应用根上下文：远程侧据此登记画布能力插件并等待运行时空闲 */
    appContext: Context
    /** 宿主创建的 CanvasRealm 上下文：文档、选中与视口服务都来自它 */
    canvasContext: CanvasContext
    /** 宿主注入的表达式作用域，如 `$route` / `$params` / `$query` */
    scope?: Record<string, unknown>
  }>

  export default CanvasModule
}
