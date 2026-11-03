<script setup lang="ts">
import { dismissToast, toastItems } from '../toast'
</script>

<template>
  <div class="lc-toast-stack" aria-live="polite" aria-label="操作提示">
    <TransitionGroup name="lc-toast">
      <div
        v-for="item in toastItems"
        :key="item.id"
        class="lc-toast"
        :class="`lc-toast--${item.level}`"
        :role="item.level === 'error' || item.level === 'warning' ? 'alert' : 'status'"
      >
        <span class="lc-toast__mark" aria-hidden="true" />
        <span class="lc-toast__text">{{ item.message }}</span>
        <button
          type="button"
          class="lc-toast__close"
          aria-label="关闭提示"
          @click="dismissToast(item.id)"
        >
          ×
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
/* ---------------------------------------------------------------------------
 * 组件级变量：语义色由全局 token 映射进来，样式本体只消费这一层
 * --------------------------------------------------------------------------- */

.lc-toast {
  --lc-toast-accent: var(--lc-accent-bright);
  --lc-toast-surface: var(--lc-surface);
  --lc-toast-border: var(--lc-border-strong);
  --lc-toast-text: var(--lc-text);
  --lc-toast-radius: var(--lc-radius-md);
  --lc-toast-shadow: var(--lc-shadow);

  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  min-width: 220px;
  max-width: 380px;
  padding: 10px 12px;
  border: 1px solid var(--lc-toast-border);
  border-radius: var(--lc-toast-radius);
  background: var(--lc-toast-surface);
  color: var(--lc-toast-text);
  box-shadow: var(--lc-toast-shadow);
  font-size: 13px;
  line-height: 1.5;
  /* 整层不拦截画布事件，但提示本身要能点关闭 */
  pointer-events: auto;
}

.lc-toast-stack {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 90;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

/* ---------------------------------------------------------------------------
 * 语义变体：只改强调色，不复制基础样式
 * --------------------------------------------------------------------------- */

.lc-toast--success {
  --lc-toast-accent: var(--lc-success);
}

.lc-toast--warning {
  --lc-toast-accent: var(--lc-warning);
}

.lc-toast--error {
  --lc-toast-accent: var(--lc-danger);
}

/* ---------------------------------------------------------------------------
 * 子元素
 * --------------------------------------------------------------------------- */

.lc-toast__mark {
  flex: none;
  width: 3px;
  height: 18px;
  border-radius: 2px;
  background: var(--lc-toast-accent);
}

.lc-toast__text {
  min-width: 0;
  flex: 1;
  word-break: break-word;
}

.lc-toast__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--lc-radius-sm);
  background: transparent;
  color: var(--lc-text-secondary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

/* hover 不是唯一反馈：键盘聚焦用同一条描边规则，保证 Tab 到关闭按钮时看得见 */
.lc-toast__close:hover,
.lc-toast__close:focus-visible {
  background: var(--lc-accent-soft);
  color: var(--lc-text);
}

.lc-toast__close:focus-visible {
  outline: 1px solid var(--lc-toast-accent);
  outline-offset: 1px;
}

/* ---------------------------------------------------------------------------
 * 进出场动画
 * --------------------------------------------------------------------------- */

.lc-toast-enter-active,
.lc-toast-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.lc-toast-enter-from,
.lc-toast-leave-to {
  opacity: 0;
  transform: translateX(12px);
}

.lc-toast-leave-active {
  /* 抽走一条时让后面的补位，而不是留出一段空白 */
  position: absolute;
  right: 0;
}

@media (prefers-reduced-motion: reduce) {
  .lc-toast,
  .lc-toast__close,
  .lc-toast-enter-active,
  .lc-toast-leave-active {
    transition: none;
  }

  .lc-toast-enter-from,
  .lc-toast-leave-to {
    transform: none;
  }
}
</style>
