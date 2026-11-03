import type { SetterEntry, SetterService } from '@lc/contracts'
import { definePlugin } from '@lc/kernel'
import type { PropType } from '@lc/schema'

/** 内置设置器：属性类型 → 基础控件 */
const BUILTIN_SETTERS: readonly SetterEntry[] = [
  { id: 'setter.string', propType: 'string', kind: 'text' },
  { id: 'setter.number', propType: 'number', kind: 'number' },
  { id: 'setter.boolean', propType: 'boolean', kind: 'toggle' },
  { id: 'setter.color', propType: 'color', kind: 'color' },
  { id: 'setter.enum', propType: 'enum', kind: 'select' },
  { id: 'setter.icon', propType: 'icon', kind: 'text' },
  { id: 'setter.json', propType: 'json', kind: 'text' },
  { id: 'setter.object', propType: 'object', kind: 'text' },
  { id: 'setter.array', propType: 'array', kind: 'text' },
  { id: 'setter.style', propType: 'style', kind: 'text' },
  { id: 'setter.event', propType: 'event', kind: 'text' },
  { id: 'setter.slot', propType: 'slot', kind: 'text' },
  { id: 'setter.function', propType: 'function', kind: 'text' },
]

/**
 * 属性设置器服务。
 *
 * 内置映射覆盖全部 PropType；插件可注册更高 priority 的同类型设置器覆盖。
 * 面板解析不到时回退文本控件（不会因为缺少设置器而无法编辑）。
 */
export default definePlugin({
  name: 'service-setter',

  apply(ctx) {
    const setters = new Map<string, SetterEntry>()
    const listeners = new Set<() => void>()
    let version = 0

    function notify(): void {
      version += 1
      for (const listener of [...listeners]) listener()
    }

    const service: SetterService = {
      register(setter): {
        /** 注销本设置器；同 id 已被重新注册时为空操作（按实例引用比对） */
        dispose(): void
      } {
        if (setters.has(setter.id)) {
          throw new Error(`[setter] 设置器 id 重复: ${setter.id}`)
        }
        setters.set(setter.id, setter)
        notify()

        return {
          dispose: () => {
            if (setters.get(setter.id) !== setter) return
            setters.delete(setter.id)
            notify()
          },
        }
      },

      get(id) {
        return setters.get(id)
      },

      list() {
        return [...setters.values()]
      },

      get version() {
        return version
      },

      onDidChange(listener) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },

      resolve(propType: PropType) {
        return [...setters.values()]
          .filter((setter) => setter.propType === propType)
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0]
      },
    }

    for (const setter of BUILTIN_SETTERS) service.register(setter)

    ctx.effect(() => ctx.provide('setter', service, { apiVersion: '1.0' }))
  },
})
