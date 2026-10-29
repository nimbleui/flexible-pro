import type { Disposable } from '@lc/kernel'

/**
 * 快捷键绑定。
 *
 * `key` 使用统一规范：`Mod+Shift+Z`、`Delete`、`Shift+ArrowUp`。
 * `Mod` 在 macOS 上表示 ⌘，其余平台表示 Ctrl；匹配时要求修饰键精确一致，
 * 避免 `ArrowUp` 与 `Shift+ArrowUp` 互相误触发。
 */
export interface Keybinding {
  /** 唯一 id，用于诊断与去重 */
  id: string
  /** 组合键规范 */
  key: string
  /** 触发的命令 id */
  command: string
  /** 传给命令的参数 */
  args?: unknown
  /** 运行条件；返回 false 时不触发，也不阻止浏览器默认行为 */
  when?(): boolean
}

/** 快捷键服务：编辑器级键盘入口，命令是唯一执行目标 */
export interface KeybindingService {
  /** 注册绑定；返回 disposable，插件卸载时自动移除 */
  register(binding: Keybinding): Disposable
  /** 当前全部绑定（注册顺序） */
  list(): readonly Keybinding[]
  /** 命令对应的主快捷键显示文本；未绑定返回 undefined */
  keyFor(command: string): string | undefined
}
