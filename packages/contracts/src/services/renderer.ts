/**
 * 渲染服务：schema → 组件。
 *
 * 契约保持框架无关（返回 unknown），Vue 适配层把组件强类型化为 Component。
 */
export interface RendererService {
  /**
   * 解析物料组件（可能触发懒加载）。
   *
   * @returns 组件对象；物料不存在或模块未导出该组件时返回 undefined。
   */
  resolveMaterial(name: string): Promise<unknown | undefined>
}
