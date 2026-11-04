<script setup lang="ts">
import type { BoxSide, BoxSides } from '../utils/style-fields'

const props = defineProps<{
  /** 四边当前显示值 */
  sides: BoxSides
}>()

const emit = defineEmits<{
  /** 某一边的文本提交；空串表示「该方向不设值」，由父组件决定删键 */
  (event: 'commit', side: BoxSide, text: string): void
}>()

/** 展示顺序即 CSS 简写顺序，读面板与读文档一致 */
const sideOrder: ReadonlyArray<{ side: BoxSide; label: string }> = [
  { side: 'top', label: '上' },
  { side: 'right', label: '右' },
  { side: 'bottom', label: '下' },
  { side: 'left', label: '左' },
]

function onCommit(side: BoxSide, event: Event): void {
  emit('commit', side, (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="lc-style-sides">
    <label v-for="item in sideOrder" :key="item.side" class="lc-style-sides__field">
      <span class="lc-style-sides__label">{{ item.label }}</span>
      <input
        type="text"
        class="lc-style-sides__input"
        :value="props.sides[item.side]"
        placeholder="—"
        title="留空表示该方向不设值"
        @change="onCommit(item.side, $event)"
      />
    </label>
  </div>
</template>

<style scoped>
.lc-style-sides {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.lc-style-sides__field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.lc-style-sides__label {
  color: var(--lc-text-secondary);
  font-size: 10px;
  text-align: center;
}

.lc-style-sides__input {
  width: 100%;
  height: 26px;
  padding: 0 4px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
  text-align: center;
  box-sizing: border-box;
}
</style>
