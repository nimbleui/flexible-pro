<script setup lang="ts">
import { provide } from 'vue'
import type { Context } from '@lc/kernel'
import { LC_CONTEXT } from '../context'

const props = defineProps<{
  /**
   * 要注入到子树的 Context；通常是 EditorRealm / CanvasRealm 的上下文
   *
   * 用组件级 provide 而不是 app.provide：同一应用里可以按子树注入不同的 Realm，
   * 嵌套时子组件取到的是最近一层（画布作用域会再注入一次）。
   */
  context: Context
}>()

provide(LC_CONTEXT, props.context)
</script>

<template>
  <slot />
</template>
