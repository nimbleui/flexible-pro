<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import type { ProjectRelease } from '../../projects/release-model'
import { toastService } from '../../toast'

/**
 * 快照源码查看弹层。
 *
 * 展示这份快照冻结的五类资产 JSON——「查看源码」看的是发布当时的内容，
 * 不是当前草稿。复制走 navigator.clipboard，失败时 toast 明示而不是静默。
 */

const props = defineProps<{
  /** 要查看的发布快照 */
  release: ProjectRelease
}>()

const emit = defineEmits<{
  (event: 'close'): void
}>()

const json = computed(() => JSON.stringify(props.release.assets, null, 2))

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(json.value)
    toastService.show('快照源码已复制到剪贴板', 'success')
  } catch {
    toastService.show('复制失败：当前环境不允许访问剪贴板', 'error')
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div class="lc-source__scrim" @click.self="emit('close')">
      <section
        class="lc-source"
        role="dialog"
        aria-modal="true"
        :aria-label="`查看源码 v${release.revision}`"
      >
        <header class="lc-source__head">
          <span class="lc-source__title">查看源码 · v{{ release.revision }}</span>
          <span class="lc-source__hint">发布当时冻结的资产内容，不含当前草稿</span>
          <button type="button" class="lc-source__button" @click="copy">复制 JSON</button>
          <button
            type="button"
            class="lc-source__button"
            aria-label="关闭源码查看"
            @click="emit('close')"
          >
            关闭
          </button>
        </header>
        <pre class="lc-source__body">{{ json }}</pre>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.lc-source__scrim {
  position: fixed;
  inset: 0;
  z-index: 1500;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--lc-app-bg) 72%, transparent);
}

.lc-source {
  display: flex;
  flex-direction: column;
  width: min(860px, 100%);
  max-height: min(84vh, 720px);
  overflow: hidden;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
}

.lc-source__head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--lc-border);
  background: var(--lc-surface-sunken);
}

.lc-source__title {
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-source__hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--lc-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-source__button {
  flex: none;
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    color 0.15s ease;
}

.lc-source__button:hover {
  border-color: var(--lc-border-strong);
  color: var(--lc-accent-bright);
}

.lc-source__body {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 14px 16px;
  overflow: auto;
  color: var(--lc-text-secondary);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  line-height: 1.7;
  scrollbar-width: thin;
  scrollbar-color: var(--lc-border-strong) transparent;
}

.lc-source :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .lc-source__button {
    transition: none;
  }
}
</style>
