import type { VNode } from 'vue'

/**
 * 页面填进复合组件的具名插槽内容。
 *
 * 单独一个类型文件而不是写在 SFC 里：`<script setup>` 不能有顶层导出，
 * 而设计态画布、运行时预览与宿主复合组件三处都要引用它。
 * 值用 Vue 的 slot 函数原样传递，渲染层不复制节点内容，位置与生命周期仍归外层树。
 */
export type SlotContent = Record<string, () => VNode[]>
