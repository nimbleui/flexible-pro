import type { Keybinding, KeybindingService } from '@lc/contracts'
import { definePlugin } from '@lc/kernel'
import { matchesKeybinding } from './keys'

export { matchesKeybinding, normalizeEventKey } from './keys'
export type { KeyInput, Platform } from './keys'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  ) {
    return true
  }
  return target.isContentEditable || Boolean(target.closest('[contenteditable="true"]'))
}

/**
 * 快捷键服务插件。
 *
 * 全局监听 keydown（输入框内跳过），命中绑定后执行命令并阻止默认行为；
 * 命令是唯一执行目标，快捷键本身不包含业务逻辑。
 */
export default definePlugin({
  name: 'service-keybinding',
  // 命中键位后唯一的执行目标是命令服务，没有它这个服务只是空转
  inject: ['command'],
  provides: ['keybinding'],

  apply(ctx) {
    const bindings: Keybinding[] = []

    const service: KeybindingService = {
      register(binding): { dispose(): void } {
        if (bindings.some((item) => item.id === binding.id)) {
          throw new Error(`[keybinding] 绑定 id 重复: ${binding.id}`)
        }
        bindings.push(binding)
        return {
          dispose: () => {
            const index = bindings.indexOf(binding)
            if (index >= 0) bindings.splice(index, 1)
          },
        }
      },

      list() {
        return [...bindings]
      },

      keyFor(command) {
        return bindings.find((item) => item.command === command)?.key
      },
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return

      for (const binding of bindings) {
        if (binding.when && !binding.when()) continue
        if (!matchesKeybinding(binding.key, event)) continue

        event.preventDefault()
        void ctx.command.execute(binding.command, binding.args)
        return
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onKeyDown)
      ctx.effect(() => ({ dispose: () => window.removeEventListener('keydown', onKeyDown) }))
    }

    ctx.effect(() => ctx.provide('keybinding', service, { apiVersion: '1.0' }))
  },
})
