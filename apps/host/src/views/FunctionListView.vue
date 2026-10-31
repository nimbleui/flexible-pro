<script setup lang="ts">
import { ref } from 'vue'
import { functionBodyText } from '../functions/function-draft'
import { globalFunctions, removeGlobalFunction } from '../functions/global-functions'

const pendingDelete = ref<string | null>(null)

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function confirmDelete(id: string): void {
  removeGlobalFunction(id)
  pendingDelete.value = null
}
</script>

<template>
  <main class="lc-functions">
    <header class="lc-functions__head">
      <div class="lc-functions__heading">
        <h1 class="lc-functions__title">自定义函数</h1>
        <p class="lc-functions__hint">
          全局函数在应用启动时注册到表达式引擎，所有页面都能按名字调用；页面自己的函数请在画布左侧组件库中维护「自定义函数」。
        </p>
      </div>
      <RouterLink class="lc-functions__primary" to="/functions/new">+ 新建函数</RouterLink>
    </header>

    <div v-if="globalFunctions.length === 0" class="lc-functions__empty">
      <span class="lc-functions__empty-title">还没有全局函数</span>
      <span>把跨页面复用的计算逻辑抽成函数，表达式里就能直接调用。</span>
      <RouterLink class="lc-functions__link" to="/functions/new">创建第一个全局函数</RouterLink>
    </div>

    <ul v-else class="lc-functions__list">
      <li v-for="fn in globalFunctions" :key="fn.id" class="lc-functions__item">
        <div class="lc-functions__item-main">
          <div class="lc-functions__item-head">
            <code class="lc-functions__name"
              >{{ fn.name }}({{ (fn.params ?? []).join(', ') }})</code
            >
            <span v-if="fn.title" class="lc-functions__label">{{ fn.title }}</span>
          </div>
          <code class="lc-functions__body">{{ functionBodyText(fn) }}</code>
          <p v-if="fn.description" class="lc-functions__desc">{{ fn.description }}</p>
        </div>

        <div class="lc-functions__item-side">
          <span class="lc-functions__time">{{ formatTime(fn.updatedAt) }}</span>

          <div class="lc-functions__actions">
            <template v-if="pendingDelete === fn.id">
              <span class="lc-functions__confirm">删除？</span>
              <button
                type="button"
                class="lc-functions__button lc-functions__button--danger"
                @click="confirmDelete(fn.id)"
              >
                确认
              </button>
              <button type="button" class="lc-functions__button" @click="pendingDelete = null">
                取消
              </button>
            </template>
            <template v-else>
              <RouterLink class="lc-functions__button" :to="`/functions/${fn.id}/edit`">
                编辑
              </RouterLink>
              <button
                type="button"
                class="lc-functions__button lc-functions__button--danger"
                @click="pendingDelete = fn.id"
              >
                删除
              </button>
            </template>
          </div>
        </div>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.lc-functions {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: 32px 36px;
  overflow: auto;
}

.lc-functions__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 22px;
}

.lc-functions__heading {
  min-width: 0;
}

.lc-functions__title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 6px;
  color: var(--lc-text);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.4px;
}

.lc-functions__title::before {
  content: '';
  width: 3px;
  height: 18px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--lc-accent-bright), var(--lc-accent));
  box-shadow: 0 0 10px var(--lc-glow);
}

.lc-functions__hint {
  max-width: 720px;
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.lc-functions__primary,
.lc-functions__button,
.lc-functions__link {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--lc-border);
  border-radius: 7px;
  background: rgba(10, 30, 61, 0.6);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.lc-functions__primary {
  border-color: rgba(55, 182, 255, 0.55);
  background: linear-gradient(135deg, var(--lc-accent), var(--lc-accent-bright));
  box-shadow: 0 0 18px rgba(47, 140, 255, 0.35);
  color: #04101f;
  font-weight: 600;
}

.lc-functions__button:hover,
.lc-functions__link:hover {
  border-color: var(--lc-border-strong);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-functions__button--danger:hover {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-functions__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 56px 24px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: rgba(6, 17, 33, 0.5);
  color: var(--lc-text-secondary);
  font-size: 13px;
  text-align: center;
}

.lc-functions__empty-title {
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-functions__link {
  margin-top: 8px;
}

.lc-functions__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-functions__item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 18px;
  overflow: hidden;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(150deg, rgba(10, 30, 61, 0.85), rgba(7, 21, 40, 0.65));
  box-shadow: 0 10px 30px rgba(0, 6, 18, 0.35);
}

.lc-functions__item-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.lc-functions__item-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.lc-functions__name {
  color: var(--lc-accent-bright);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 13px;
}

.lc-functions__label {
  overflow: hidden;
  color: var(--lc-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-functions__body {
  overflow: hidden;
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-functions__desc {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.lc-functions__item-side {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

.lc-functions__time {
  color: var(--lc-text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.lc-functions__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lc-functions__confirm {
  color: var(--lc-danger);
  font-size: 11px;
}

.lc-functions :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (max-width: 900px) {
  .lc-functions__item {
    flex-direction: column;
  }

  .lc-functions__item-side {
    align-items: flex-start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-functions__primary,
  .lc-functions__button,
  .lc-functions__link {
    transition: none;
  }
}
</style>
