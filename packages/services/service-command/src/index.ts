import type { Command, CommandService } from '@lc/contracts'
import { definePlugin } from '@lc/kernel'

/**
 * 命令服务插件。
 *
 * 命令是菜单、快捷键、工具栏与命令面板的唯一执行入口；
 * 执行错误只上报诊断，不向 UI 抛出。
 */
export default definePlugin({
  name: 'service-command',

  apply(ctx) {
    const commands = new Map<string, Command>()
    const listeners = new Set<() => void>()

    // 注册表版本号：命令面板等消费者用它判断是否需要重新取列表
    let version = 0

    function notify(): void {
      version += 1
      for (const listener of [...listeners]) listener()
    }

    const service: CommandService = {
      /**
       * 注册命令。
       *
       * id 冲突抛错而不覆盖：两个插件抢同一命令会让其中一方的 UI 贡献静默失效。
       *
       * @throws 命令 id 重复时抛错。
       */
      register(command): {
        /** 注销本命令；命令已被同 id 重新注册时为空操作（按实例引用比对） */
        dispose(): void
      } {
        if (commands.has(command.id)) {
          throw new Error(`[command] 命令 id 重复: ${command.id}`)
        }
        commands.set(command.id, command)
        notify()

        return {
          dispose: () => {
            // 比对引用，避免迟到的 dispose 删掉别人后来注册的同名命令
            if (commands.get(command.id) !== command) return
            commands.delete(command.id)
            notify()
          },
        }
      },

      get(id) {
        return commands.get(id)
      },

      /** 注册顺序列表；不做排序，展示顺序由工具栏等贡献点的 order 决定 */
      list() {
        return [...commands.values()]
      },

      get version() {
        return version
      },

      onDidChange(listener) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },

      /**
       * 执行命令。
       *
       * 三条退出路径都不向调用方抛错：命令不存在只记诊断；`enabled` 为 false 时
       * 静默跳过（置灰本身就是预期，不该刷诊断）；`run` 抛错被捕获后上报。
       * 异步命令会被 await，调用方可以据此串接后续操作。
       */
      async execute(id, args) {
        const command = commands.get(id)
        if (!command) {
          ctx.diagnostics.report(new Error(`命令不存在: ${id}`), { scope: 'command', id })
          return
        }
        if (command.enabled && !command.enabled()) return

        try {
          await command.run({ args })
        } catch (error) {
          ctx.diagnostics.report(error, { scope: 'command', id })
        }
      },
    }

    ctx.effect(() => ctx.provide('command', service, { apiVersion: '1.0' }))
  },
})
