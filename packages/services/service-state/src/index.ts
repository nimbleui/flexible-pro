import type { StateService } from '@lc/contracts'
import { defineEditorPlugin } from '@lc/contracts'
import type { PageVariableSchema } from '@lc/schema'

/**
 * 变量声明到默认值指纹的映射。
 *
 * 包一层对象再 `JSON.stringify`：直接序列化 `defaultValue` 时 `undefined` 返回
 * `undefined` 而不是字符串，声明里「没有默认值」和「默认值是别的什么」就没法区分。
 */
function fingerprintOf(variable: PageVariableSchema): string {
  return JSON.stringify({ v: variable.defaultValue })
}

/**
 * 状态服务的值表。
 *
 * 单独成类型是因为「对齐」是一段有状态、有分支的纯逻辑：把它从插件装配里拆出来，
 * 才能不建内核 Context 就把它测全（与 `service-datasource` 只测纯 `rest` 同一口径）。
 */
export interface StateTable {
  /** 变量当前值 */
  values: Map<string, unknown>
  /** 变量默认值指纹；同时充当「该变量已在页面中声明」的判据 */
  fingerprints: Map<string, string>
}

/**
 * 把值表对齐到新的变量声明。
 *
 * 规则：
 * - 新变量按默认值登记；
 * - 默认值被编辑过的变量重置——设计器里改了默认值必须立刻看到效果，否则用户会以为
 *   编辑没生效；运行期不会改声明，这条分支不会被触发；
 * - 声明中消失的变量整体删除，否则 `snapshot()` 会吐出幽灵值；
 * - **其余情况保留当前值**：文档任何无关编辑都不应该把用户运行时改出来的状态冲掉。
 *
 * @param table 原地更新的值表
 * @param variables 当前声明
 * @returns 值表是否发生了变化，供调用方决定是否广播
 */
export function alignState(
  table: StateTable,
  variables: readonly PageVariableSchema[],
): boolean {
  let changed = false
  const declared = new Set<string>()

  for (const variable of variables) {
    declared.add(variable.name)
    const fingerprint = fingerprintOf(variable)
    if (table.fingerprints.get(variable.name) === fingerprint) continue

    table.fingerprints.set(variable.name, fingerprint)
    table.values.set(variable.name, variable.defaultValue)
    changed = true
  }

  for (const name of [...table.fingerprints.keys()]) {
    if (declared.has(name)) continue

    table.fingerprints.delete(name)
    table.values.delete(name)
    changed = true
  }

  return changed
}

/**
 * 页面状态运行时插件（Realm 级）。
 *
 * 值表随文档走：切换文档即换一套状态。声明来自 `PageSchema.variables`，本服务只维护
 * 「当前值」，永不写回 schema——写回会污染文档并进入撤销历史。
 */
export default defineEditorPlugin({
  name: 'service-state',
  inject: ['document'],

  apply(ctx) {
    const document = ctx.document
    const table: StateTable = { values: new Map(), fingerprints: new Map() }
    const listeners = new Set<() => void>()
    let disposed = false

    function notify(): void {
      for (const listener of [...listeners]) listener()
    }

    /** 按当前声明对齐值表；只有真的变了才广播 */
    function sync(): void {
      if (disposed) return
      if (alignState(table, document.model.schema.variables ?? [])) notify()
    }

    const service: StateService = {
      snapshot() {
        // null 原型：变量名是用户输入的，普通对象会让 `snapshot().toString`
        // 这类未声明的键读到 Object.prototype 上的成员
        const snapshot: Record<string, unknown> = Object.create(null)
        for (const [key, value] of table.values) snapshot[key] = value
        return snapshot
      },

      get: (key) => table.values.get(key),

      has: (key) => table.fingerprints.has(key),

      set(key, value) {
        // 销毁后仍可能收到写入：动作链里的 `dataSource.fetch` 在 await 期间用户关掉
        // 文档，请求回来时处理器还会继续调 `state.set`。此时表已清空，写进去的
        // 是一条谁也不会再读的幽灵记录。
        if (disposed || !table.fingerprints.has(key)) return

        table.values.set(key, value)
        notify()
      },

      reset(key) {
        if (disposed) return

        const variables = document.model.schema.variables ?? []
        let changed = false

        for (const variable of variables) {
          if (key !== undefined && variable.name !== key) continue

          table.values.set(variable.name, variable.defaultValue)
          changed = true
        }

        if (changed) notify()
      },

      onDidChange(listener) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
    }

    ctx.effect(() =>
      ctx.provide('pageState', service, {
        apiVersion: '1.0',
      }),
    )
    ctx.effect(() => document.onDidChange(sync))
    ctx.effect(() => ({
      dispose: () => {
        disposed = true
        table.values.clear()
        table.fingerprints.clear()
        listeners.clear()
      },
    }))

    sync()
  },
})
