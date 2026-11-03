<script setup lang="ts">
import { defineAsyncComponent, onUnmounted, ref, watch } from 'vue'
import type { FunctionDescriptor } from '@lc/schema'
import type { ScopeSymbol } from '@lc/expression/editor'

const props = defineProps<{
  /** 属性当前原始值（可能是纯文本，也可能是 {{ ... }} 模板） */
  modelValue: string
  /** 页面数据、路由与循环变量 */
  symbols: readonly ScopeSymbol[]
  /** 当前生效函数 */
  functions: readonly FunctionDescriptor[]
  /** 字段标题，用于编辑器 aria-label */
  label?: string
}>()

const emit = defineEmits<{
  (event: 'commit', value: string): void
}>()

/** CodeMirror 体积较大，只有进入表达式模式才加载 */
const ExpressionCodeEditor = defineAsyncComponent(() => import('@lc/expression-editor'))

const draft = ref(props.modelValue)
let timer: ReturnType<typeof setTimeout> | null = null

function cancelTimer(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

watch(
  () => props.modelValue,
  (value) => {
    if (value !== draft.value) draft.value = value
  },
)

// 输入停顿后提交，避免每敲一个字符写一条历史；失焦时立即冲刷
watch(draft, (value) => {
  if (value === props.modelValue) return

  cancelTimer()
  timer = setTimeout(() => {
    timer = null
    emit('commit', value)
  }, 500)
})

function flush(): void {
  cancelTimer()
  if (draft.value !== props.modelValue) emit('commit', draft.value)
}

onUnmounted(cancelTimer)
</script>

<template>
  <ExpressionCodeEditor
    v-model="draft"
    :functions="props.functions"
    :symbols="props.symbols"
    mode="template"
    :show-signature="false"
    :aria-label="props.label ? `${props.label}表达式` : '属性表达式'"
    placeholder="纯文本，或 {{ data.user.name }}"
    :min-height="64"
    @blur="flush"
  />
</template>
