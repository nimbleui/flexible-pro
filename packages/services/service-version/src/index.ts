/**
 * `@lc/service-version`：版本控制内核。
 *
 * 纯 Core，不依赖 Vue / DOM / Realm；浏览器 API 只出现在 `store/idb.ts` 适配器里。
 * 公共类型统一从 `@lc/contracts` 导入，本包不重复声明契约。
 */

export * from './errors'
export * from './refs'
export * from './object'
export * from './dag'
export * from './diff'
export * from './merge'
export * from './merge-plan'
export * from './tracker'
export * from './projection'
export * from './version-mode'
export * from './legacy'
export * from './service'
export * from './store/memory'
export * from './store/idb'
