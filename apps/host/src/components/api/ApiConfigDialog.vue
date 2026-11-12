<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import ApiRequestConfigPanel from './ApiRequestConfigPanel.vue'

/**
 * 全局请求配置弹框。
 *
 * 接口管理页顶部的卡片是摘要，完整编辑（环境增删、域名、默认头、凭据、响应头登记）
 * 收在这里：卡片上每个「添加 / 编辑」入口都打开它并聚焦到对应环境，避免在摘要上
 * 直接堆出一套半功能的表单。
 */

const props = defineProps<{
  /** 是否打开 */
  open: boolean
  /** 环境归属的项目 id */
  projectId: string
  /** 打开时聚焦编辑的环境 id */
  focusEnvId?: string
}>()

const emit = defineEmits<{
  (event: 'close'): void
}>()

const closeButton = ref<HTMLButtonElement | null>(null)

function requestClose(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open || event.key !== 'Escape') return
  event.preventDefault()
  requestClose()
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    closeButton.value?.focus()
  },
  { immediate: true },
)

onMounted(() => window.addEventListener('keydown', onKeydown))

onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="lc-api-config-dialog" @mousedown.self="requestClose">
      <section
        class="lc-api-config-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-api-config-dialog-title"
      >
        <header class="lc-api-config-dialog__head">
          <div>
            <h2 id="lc-api-config-dialog-title" class="lc-api-config-dialog__title">
              全局请求配置
            </h2>
            <p class="lc-api-config-dialog__subtitle">
              域名、默认头、凭据与响应头登记按环境保存；切换生效环境后，已打开页面的接口数据会重新取一次。
            </p>
          </div>
          <button
            ref="closeButton"
            type="button"
            class="lc-api-config-dialog__close"
            aria-label="关闭全局请求配置弹框"
            @click="requestClose"
          >
            ×
          </button>
        </header>

        <div class="lc-api-config-dialog__body">
          <ApiRequestConfigPanel
            v-if="open"
            :key="focusEnvId ?? 'active'"
            :project-id="projectId"
            :focus-env-id="focusEnvId"
          />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.lc-api-config-dialog {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(2, 8, 20, 0.62);
  backdrop-filter: blur(3px);
}

.lc-api-config-dialog__panel {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  max-height: min(86vh, 860px);
  overflow: hidden;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
}

.lc-api-config-dialog__head {
  display: flex;
  flex: none;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-api-config-dialog__title {
  margin: 0 0 4px;
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 650;
}

.lc-api-config-dialog__subtitle {
  margin: 0;
  max-width: 560px;
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.lc-api-config-dialog__close {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: none;
  color: var(--lc-text-secondary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.lc-api-config-dialog__close:hover {
  border-color: var(--lc-border-strong);
  color: var(--lc-text);
}

.lc-api-config-dialog__body {
  flex: 1;
  min-height: 0;
  padding: 14px 18px 18px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--lc-border-strong) transparent;
}

.lc-api-config-dialog__body::-webkit-scrollbar {
  width: 8px;
}

.lc-api-config-dialog__body::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: var(--lc-border-strong);
}

.lc-api-config-dialog__close:focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .lc-api-config-dialog {
    backdrop-filter: none;
  }
}
</style>
