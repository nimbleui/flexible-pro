import type { FlowDefinition } from '@lc/schema'

/**
 * 流程图仓库服务（应用级）。
 *
 * 事件链的图形态是**可独立发版的文档**，不属于任何单个页面文档，所以它不能像
 * `PageSchema.connections` 那样由 EditorRealm 的文档服务直接给出。本服务是运行时
 * 唯一的入口：「这个来源节点的这个名字的事件，现在该执行哪张图」。
 *
 * 刻意只提供查询、不提供执行：执行归 `ActionService`，否则「谁触发什么」这件事会有
 * 两个地方各自决定一次，调试时无法对照。
 *
 * 与 `toast` / `navigation` 同类，本服务名不在保留清单里：宿主换成服务端图仓库、
 * 或按租户做权限过滤，都是正当用法。
 */
export interface FlowService {
  /**
   * 按事件键取**已发布**的流程图。
   *
   * 只认已发布版本：草稿参与匹配会让作者正在编辑的半张图抢先执行。
   * 同一事件键被多张已发布的图占用属于数据错误，由写入侧（发布动作）拦下，
   * 这里只返回第一个命中项，不在热路径上做重复校验。
   *
   * @param sourceNodeId 事件来源节点 id；页面级事件传 `'page'`
   * @param eventName 事件名
   * @returns 命中的流程图；没有绑定时返回 undefined
   */
  findPublished(sourceNodeId: string, eventName: string): FlowDefinition | undefined
}
