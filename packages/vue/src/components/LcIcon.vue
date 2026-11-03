<script setup lang="ts">
import { computed } from 'vue'
import { lcIconPaths } from '../icons'

const props = withDefaults(
  defineProps<{
    /** 图标名，取自共享注册表；未注册名回退成方框而不是空白 */
    name: string
    /** 显示边长（px），图标始终是正方形的 */
    size?: number
  }>(),
  { size: 16 },
)

const paths = computed(() => lcIconPaths(props.name))
</script>

<template>
  <!-- 图标一律装饰性：可读名称由承载它的按钮 / 行自己用 aria-label 给出 -->
  <svg
    class="lc-icon"
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, index) in paths" :key="index" :d="d" />
  </svg>
</template>

<style scoped>
.lc-icon {
  display: block;
  flex: none;
  /* 描边属性可继承，写在 svg 上就不必给每条 path 重复一遍 */
  fill: none;
  stroke: currentcolor;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
