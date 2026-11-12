<script setup lang="ts">
/**
 * 开关。
 *
 * 语义是「立即生效的布尔切换」，与复选框（表单里待提交的一项）区分：接口管理页的
 * Token 启用、是否公开都用它。完全受控：点击只发事件、不让浏览器原生翻转 checked，
 * 视觉始终由 `modelValue` 驱动——否则「点了但父级没改值」（如 Token 开启转去弹框补全）
 * 会让开关停在选中态而实际仍是关闭。无障碍上按 switch 播报选中态。
 */

withDefaults(
  defineProps<{
    /** 当前是否打开 */
    modelValue: boolean
    /** 无障碍名；开关本身没有可见文本时必填（内部绑到 aria-label） */
    label: string
    /** 禁用时不响应点击 */
    disabled?: boolean
  }>(),
  { disabled: false },
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()
</script>

<template>
  <label class="lc-switch" :class="{ 'is-disabled': disabled }">
    <input
      type="checkbox"
      class="lc-switch__input"
      role="switch"
      :checked="modelValue"
      :aria-checked="modelValue"
      :disabled="disabled"
      :aria-label="label"
      @click.prevent="emit('update:modelValue', !modelValue)"
    />
    <span class="lc-switch__track" aria-hidden="true">
      <span class="lc-switch__thumb"></span>
    </span>
  </label>
</template>

<style scoped>
.lc-switch {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  cursor: pointer;
}

.lc-switch.is-disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.lc-switch__input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.lc-switch__track {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  width: 36px;
  height: 20px;
  padding: 2px;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-pill);
  background: var(--lc-surface-sunken);
  transition:
    background-color var(--lc-motion-base) var(--lc-ease-out),
    border-color var(--lc-motion-base) var(--lc-ease-out);
}

.lc-switch__thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--lc-text-muted);
  transition:
    transform var(--lc-motion-base) var(--lc-ease-out),
    background-color var(--lc-motion-base) var(--lc-ease-out);
}

.lc-switch__input:checked + .lc-switch__track {
  border-color: var(--lc-accent);
  background: linear-gradient(135deg, var(--lc-accent-bright), var(--lc-accent));
  box-shadow: 0 0 10px var(--lc-glow-soft);
}

.lc-switch__input:checked + .lc-switch__track .lc-switch__thumb {
  transform: translateX(16px);
  background: var(--lc-on-accent);
}

.lc-switch__input:focus-visible + .lc-switch__track {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .lc-switch__track,
  .lc-switch__thumb {
    transition: none;
  }
}
</style>
