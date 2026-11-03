<script setup lang="ts">
import type { SlotName } from '@lc/contracts'
import { LcSlot } from '@lc/vue'

defineProps<{
  /** 浮层标题，同时用作无障碍标签；标题归外壳画，面板内容不再各占一行 */
  title: string

  /** 浮层承载的宿主插槽名 */
  slotName: SlotName

  /** 传给面板贡献的只读上下文，如 { documentId } */
  context?: Record<string, unknown>
}>()

const emit = defineEmits<{
  /** 点关闭按钮；可见性由调用方持有，浮层自己不记状态 */
  close: []
}>()
</script>

<template>
  <section class="lc-overlay" :aria-label="title">
    <header class="lc-overlay__head">
      <span class="lc-overlay__title">{{ title }}</span>
      <button
        type="button"
        class="lc-icon-button"
        :aria-label="`关闭${title}`"
        :title="`关闭${title}`"
        @click="emit('close')"
      >
        <span aria-hidden="true">×</span>
      </button>
    </header>

    <div class="lc-overlay__body">
      <LcSlot :name="slotName" :context="context">
        <template #empty>
          <div class="lc-app__empty">暂无面板贡献</div>
        </template>
      </LcSlot>
    </div>
  </section>
</template>

<style scoped>
/* 定位参照是 .lc-designer__stage（已是 relative）：浮层正好盖住画布，不压底部停靠区 */
.lc-overlay {
  position: absolute;
  inset: 12px 12px 12px auto;
  z-index: 30;
  display: flex;
  flex: none;
  flex-direction: column;
  width: 280px;
  overflow: hidden;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-rail-bg);
  box-shadow: var(--lc-shadow);
}

.lc-overlay__head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 38px;
  padding: 0 6px 0 12px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-overlay__title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--lc-text);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.lc-overlay__title::before {
  content: '';
  width: 3px;
  height: 12px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--lc-accent-bright), var(--lc-accent));
  box-shadow: 0 0 8px var(--lc-glow);
}

/* 滚动条放在这一层：面板内容的吸顶头部才有稳定的参照 */
.lc-overlay__body {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  padding: 0 10px;
  overflow-y: auto;
}
</style>
