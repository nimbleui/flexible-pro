/**
 * 契约层统一入口。
 *
 * 插件只依赖一个入口；本包只放类型、常量、纯函数，
 * 不依赖 Vue / DOM / services / plugins / apps。
 */

export * from './geometry'
export * from './json'
export * from './slots'
export * from './permissions'
export * from './events'
export * from './drag'
export * from './nodes'
export * from './manifest'
export * from './contribution'
export * from './canvas-contributions'
export * from './contexts'

export * from './services/registry'
export * from './services/modules'
export * from './services/material'
export * from './services/command'
export * from './services/keybinding'
export * from './services/setter'
export * from './services/selection'
export * from './services/document'
export * from './services/history'
export * from './services/workspace'
export * from './services/canvas'
export * from './services/datasource'
export * from './services/http'
export * from './services/flow'
export * from './services/loader'
export * from './services/renderer'
export * from './services/state'
export * from './services/action'
export * from './services/toast'
export * from './services/navigation'
export * from './services/version'
