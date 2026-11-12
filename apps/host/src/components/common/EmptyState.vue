<script setup lang="ts">
/**
 * 统一空状态组件。
 *
 * 各列表视图的「没有数据」场景共用一份科技感视觉：网格底纹 + 蓝紫光晕 + 发光标记。
 * 文案与操作由调用方传入，组件只负责呈现与品牌质感，不耦合任何具体业务。
 */
defineProps<{
  /** 主标题，例如「这个项目还没有页面」 */
  title: string
  /** 补充说明，可选 */
  description?: string
}>()
</script>

<template>
  <section class="lc-empty" role="status">
    <span class="lc-empty__glow" aria-hidden="true" />
    <span class="lc-empty__mark" aria-hidden="true">
      <span class="lc-empty__ring" />
      <span class="lc-empty__core" />
    </span>
    <h2 class="lc-empty__title">{{ title }}</h2>
    <p v-if="description" class="lc-empty__desc">{{ description }}</p>
    <div v-if="$slots.actions" class="lc-empty__actions">
      <slot name="actions" />
    </div>
  </section>
</template>

<style scoped>
.lc-empty {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 56px 24px;
  overflow: hidden;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(150deg, var(--lc-surface), var(--lc-surface-sunken));
  color: var(--lc-text-secondary);
  font-size: 13px;
  text-align: center;
}

/* 顶部蓝紫光晕：呼应全局网格与霓虹，让空状态也有「在线控制台」的能量感 */
.lc-empty__glow {
  position: absolute;
  top: -40%;
  left: 50%;
  width: 380px;
  height: 380px;
  transform: translateX(-50%);
  pointer-events: none;
  background: radial-gradient(circle at 50% 50%, rgba(47, 140, 255, 0.18), transparent 60%);
}

.lc-empty__mark {
  position: relative;
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  margin-bottom: 4px;
}

.lc-empty__ring {
  position: absolute;
  inset: 0;
  border: 1px solid var(--lc-border-strong);
  border-radius: 50%;
  box-shadow: 0 0 18px var(--lc-glow-soft, rgba(47, 140, 255, 0.22));
}

.lc-empty__core {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--lc-accent-bright), var(--lc-accent-2));
  box-shadow: 0 0 14px var(--lc-glow);
}

.lc-empty__title {
  margin: 0;
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-empty__desc {
  max-width: 420px;
  margin: 0;
  color: var(--lc-text-secondary);
  line-height: 1.6;
}

.lc-empty__actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

@media (prefers-reduced-motion: reduce) {
  .lc-empty__glow {
    opacity: 0.6;
  }
}
</style>
