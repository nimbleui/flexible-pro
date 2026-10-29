import type { Registry } from './registry'

/** 命令执行上下文 */
export interface CommandContext {
  /** 调用方传入的参数；命令实现自行校验 */
  readonly args?: unknown
}

/**
 * 设计时命令。
 *
 * 命令是菜单、快捷键、工具栏、命令面板的共同落点；
 * 画布插件通过命令暴露「放大 / 缩小 / fit / 对齐」等能力。
 */
export interface Command {
  /** 全局唯一 id，建议 `<domain>.<action>`，如 `canvas.zoomIn` */
  id: string
  /** 展示名，用于菜单与命令面板 */
  title: string
  /**
   * 当前是否可用。
   *
   * 工具栏与命令面板据此置灰；`execute` 也会跳过不可用命令。
   * 必须是廉价纯函数，调用频率与渲染一致。
   */
  enabled?(): boolean
  /** 执行命令；抛错由 CommandService 捕获并上报 */
  run(ctx: CommandContext): void | Promise<void>
}

/** 命令服务 */
export interface CommandService extends Registry<Command> {
  /** 执行命令；未注册时不抛错，只上报诊断 */
  execute(id: string, args?: unknown): Promise<void>
}
