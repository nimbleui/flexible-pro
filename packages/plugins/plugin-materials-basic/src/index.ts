import { Box, Button, Circle, Group, Text } from './components'

export { Box, Button, Circle, Group, Text }

/** 物料模块约定导出：物料名 → 组件 */
export const components = { Box, Text, Circle, Group, Button }

export default { components }

/**
 * 基础物料插件（纯声明式）。
 *
 * 没有 `main` 与 `apply`：装载器只注册元数据，组件模块在首次渲染时懒加载。
 * 这就是「装即用」：新增一个组件只需新增包与 manifest，不改宿主。
 */
export { manifest } from './manifest'
