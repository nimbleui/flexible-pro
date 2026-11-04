<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  /** 表单标题 */
  label: string
  /** 当前 CSS 颜色原文，允许 `rgb()`、`var(--x)`、颜色关键字 */
  value: string
}>()

const emit = defineEmits<{
  /** 提交新的颜色文本 */
  (event: 'commit', text: string): void
}>()

/**
 * 取色器能如实反映当前值的唯一条件是 `#rrggbb`。
 *
 * 其余写法一律给白色而不是硬塞进去：文本框才是权威显示，取色器只是一个「挑个颜色」
 * 的快捷入口。存在非十六进制值时把取色器标成警示态，避免用户以为画布上的颜色和这块
 * 方块一致；没设值不算警示，挑一个颜色正是该做的事。
 */
const HEX_ONLY = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const isHex = computed(() => HEX_ONLY.test(props.value))
const exact = computed(() => props.value === '' || isHex.value)
const swatch = computed(() => (isHex.value ? props.value : '#ffffff'))

function onText(event: Event): void {
  emit('commit', (event.target as HTMLInputElement).value)
}

function onSwatch(event: Event): void {
  emit('commit', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <label class="lc-style-color">
    <span class="lc-style-color__label">{{ props.label }}</span>
    <span class="lc-style-color__row">
      <input
        type="color"
        class="lc-style-color__swatch"
        :class="{ 'lc-style-color__swatch--approx': !exact }"
        :value="swatch"
        :title="exact ? '取色器' : '当前值不是 #rrggbb，取色器只是近似色；请用右侧文本框修改'"
        :aria-label="`${props.label}取色器`"
        @change="onSwatch"
      />
      <input
        type="text"
        class="lc-style-color__text"
        :value="props.value"
        placeholder="如 var(--brand)"
        :aria-label="props.label"
        @change="onText"
      />
    </span>
  </label>
</template>

<style scoped>
.lc-style-color {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.lc-style-color__label {
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-style-color__row {
  display: flex;
  gap: 4px;
  min-width: 0;
}

.lc-style-color__swatch {
  flex: none;
  width: 28px;
  height: 26px;
  padding: 2px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface);
  box-sizing: border-box;
}

/* 非十六进制时取色器显示的是近似色，用虚线框把「这里不可信」说出来 */
.lc-style-color__swatch--approx {
  border-style: dashed;
  border-color: var(--lc-warning);
}

.lc-style-color__text {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
  box-sizing: border-box;
}

.lc-style-color__swatch:focus-visible,
.lc-style-color__text:focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}
</style>
