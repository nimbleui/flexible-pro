<script setup lang="ts">
import { onErrorCaptured, ref, watch } from 'vue'
import { useAppContext } from '../context'

const props = defineProps<{
  /** 贡献来源插件名，用于诊断归属；缺省按 'unknown' 上报 */
  plugin?: string

  /** 面板标题，用于降级提示；未传时回退成插件名 */
  title?: string
}>()

const ctx = useAppContext()

/** 捕获到的错误；非 null 即进入降级态，直到 props.plugin 变化才复位 */
const error = ref<unknown>(null)

onErrorCaptured((caught) => {
  error.value = caught
  ctx.diagnostics.report(caught, { scope: 'plugin-ui', plugin: props.plugin ?? 'unknown' })

  // 阻止错误继续冒泡到整个设计器
  return false
})

// 同一个边界实例被复用去渲染别的面板时必须复位，否则会一直显示上一个插件的错误
watch(
  () => props.plugin,
  () => {
    error.value = null
  },
)
</script>

<template>
  <div class="lc-boundary">
    <div v-if="error" class="lc-boundary__fallback" role="alert">
      {{ title || plugin }} 渲染失败：{{
        error instanceof Error ? error.message : String(error)
      }}
    </div>
    <slot v-else />
  </div>
</template>

<style scoped>
.lc-boundary {
  /* 边界不参与布局：包一层组件不能给父插槽多出盒子，否则 flex 间距会错 */
  display: contents;
}

.lc-boundary__fallback {
  padding: 10px 12px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 12px;
  line-height: 1.5;
}
</style>
