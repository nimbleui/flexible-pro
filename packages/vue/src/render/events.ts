/**
 * 事件名到 vnode 监听器 prop 名的映射。
 *
 * 这是 Vue 的匹配规则，不是平台的：组件 `emit('change')` 时，Vue 用
 * `on` + 首字母大写的 **camelCase** 事件名去 props 里找处理器。所以
 * `value-change` 对应 `onValueChange`，而不是字面拼接的 `onValue-change`——
 * 少这一步，带连字符的事件就永远接不上动作链，且不报任何错。
 *
 * @param eventName 物料声明的事件名
 * @returns 可以直接放进 vnode props 的监听器键名
 */
export function eventListenerProp(eventName: string): string {
  const camel = eventName.replace(/-(\w)/g, (_match, char: string) => char.toUpperCase())

  return `on${camel.charAt(0).toUpperCase()}${camel.slice(1)}`
}
