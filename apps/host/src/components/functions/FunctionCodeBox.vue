<script setup lang="ts">
import { defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue'
import type { FunctionDescriptor } from '@lc/schema'
import type { ScopeSymbol } from '@lc/expression/editor'
import { toastService } from '../../toast'

/** CodeMirror 体积较大，随函数控制台按需加载 */
const ExpressionCodeEditor = defineAsyncComponent(() => import('@lc/expression-editor'))

/** ExpressionCodeEditor 通过 defineExpose 暴露的最小面 */
interface CodeEditorExpose {
  /** 在当前光标处插入文本；异步组件未就绪时取到 null，调用方需判空 */
  insert(text: string): void
}

const props = withDefaults(
  defineProps<{
    /** 表达式原文，双向绑定 */
    modelValue: string
    /** 补全与签名用的函数目录 */
    functions: readonly FunctionDescriptor[]
    /** 作用域可见符号；函数体里只有形参 */
    symbols?: readonly ScopeSymbol[]
    /** 区块标题 @default '代码编辑' */
    label?: string
    /** 编辑器最小高度（CSS 像素） @default 180 */
    minHeight?: number
  }>(),
  { symbols: () => [], label: '代码编辑', minHeight: 180 },
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
}>()

const editor = ref<CodeEditorExpose | null>(null)
const fullscreen = ref(false)

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.modelValue)
    toastService.show('函数体已复制到剪贴板', 'success')
  } catch {
    toastService.show('复制失败：当前环境不允许访问剪贴板', 'error')
  }
}

function toggleFullscreen(): void {
  fullscreen.value = !fullscreen.value
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && fullscreen.value) fullscreen.value = false
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
})

/** 转发光标插入：参考面板点击函数名时由控制台调用 */
function insert(text: string): void {
  editor.value?.insert(text)
}

defineExpose({ insert })
</script>

<template>
  <div class="lc-codebox" :class="{ 'lc-codebox--fullscreen': fullscreen }">
    <div class="lc-codebox__bar">
      <span class="lc-codebox__badge" aria-hidden="true">&lt;/&gt;</span>
      <span class="lc-codebox__label">{{ label }}</span>
      <span class="lc-codebox__lang" title="引擎执行纯表达式，不是 TypeScript">表达式</span>

      <span class="lc-codebox__spacer" />

      <button type="button" class="lc-codebox__tool" title="复制函数体" @click="copy">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <rect
            x="5.5"
            y="5.5"
            width="8"
            height="8"
            rx="1.5"
            fill="none"
            stroke="currentColor"
          />
          <path
            d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1"
            fill="none"
            stroke="currentColor"
          />
        </svg>
      </button>
      <button
        type="button"
        class="lc-codebox__tool"
        :title="fullscreen ? '退出全屏（Esc）' : '全屏编辑'"
        @click="toggleFullscreen"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            v-if="!fullscreen"
            d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
          />
          <path
            v-else
            d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
          />
        </svg>
      </button>
    </div>

    <div class="lc-codebox__editor">
      <ExpressionCodeEditor
        ref="editor"
        :model-value="modelValue"
        :functions="functions"
        :symbols="symbols"
        line-numbers
        :min-height="minHeight"
        aria-label="函数体表达式"
        placeholder="如 list.filter(t => t.done).length + ' / ' + list.length"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </div>
  </div>

  <Teleport to="body">
    <div v-if="fullscreen" class="lc-codebox__scrim" @click="fullscreen = false" />
  </Teleport>
</template>

<style scoped>
.lc-codebox {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.lc-codebox__bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lc-codebox__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: linear-gradient(135deg, var(--lc-accent), var(--lc-accent-2));
  color: var(--lc-on-accent);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: var(--lc-font-size-3xs);
  font-weight: 700;
}

.lc-codebox__label {
  color: var(--lc-text);
  font-size: 12px;
  font-weight: 600;
}

.lc-codebox__lang {
  padding: 1px 8px;
  border: 1px solid var(--lc-border);
  border-radius: 999px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-size: 10px;
  cursor: help;
}

.lc-codebox__spacer {
  flex: 1;
}

.lc-codebox__tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    color 0.15s ease,
    background-color 0.15s ease;
}

.lc-codebox__tool:hover {
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-codebox__editor {
  min-width: 0;
}

/* 全屏：面板脱离布局盖住工作区，编辑器撑满剩余高度，Esc 或点击遮罩退出 */
.lc-codebox--fullscreen {
  position: fixed;
  inset: 24px;
  z-index: 90;
  padding: 16px;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
}

.lc-codebox--fullscreen .lc-codebox__editor {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.lc-codebox--fullscreen .lc-codebox__editor :deep(.lc-expression-editor) {
  flex: 1;
  min-height: 0;
}

.lc-codebox--fullscreen .lc-codebox__editor :deep(.lc-expression-editor__host) {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.lc-codebox--fullscreen .lc-codebox__editor :deep(.cm-editor) {
  flex: 1;
  min-height: 0;
}

.lc-codebox__scrim {
  position: fixed;
  inset: 0;
  z-index: 89;
  background: rgba(2, 8, 20, 0.6);
  backdrop-filter: blur(2px);
}

.lc-codebox :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .lc-codebox__tool {
    transition: none;
  }
}
</style>
