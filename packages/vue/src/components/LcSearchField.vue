<script setup lang="ts">
import LcIcon from './LcIcon.vue'

defineProps<{
  /** 输入框绑定值 */
  modelValue: string

  /** 占位文案；由使用方给出，避免面板把「搜索什么」交给组件猜 */
  placeholder: string
}>()

const emit = defineEmits<{
  /** 输入变化后的新值；清空按钮走同一个事件，调用方不必区分来源 */
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <div class="lc-search">
    <LcIcon class="lc-search__icon" name="search" :size="14" />
    <input
      class="lc-search__input"
      type="search"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="placeholder"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button
      v-if="modelValue"
      class="lc-search__clear"
      type="button"
      aria-label="清空搜索"
      title="清空搜索"
      @click="emit('update:modelValue', '')"
    >
      <span aria-hidden="true">×</span>
    </button>
  </div>
</template>

<style scoped>
.lc-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: rgba(6, 17, 33, 0.6);
  color: var(--lc-text-secondary);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.lc-search:focus-within {
  border-color: var(--lc-border-strong);
  box-shadow: 0 0 0 1px var(--lc-accent-soft);
}

/* 浏览器自带的 search 清除按钮与自定义清空按钮会重叠，统一关掉原生的 */
.lc-search__input::-webkit-search-cancel-button {
  appearance: none;
  -webkit-appearance: none;
}

.lc-search__input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--lc-text);
  font: inherit;
  font-size: 12px;
  outline: none;
}

.lc-search__input::placeholder {
  color: var(--lc-text-muted);
}

.lc-search__clear {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--lc-text-secondary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.lc-search__clear:hover {
  background: var(--lc-accent-soft);
  color: var(--lc-text);
}
</style>
