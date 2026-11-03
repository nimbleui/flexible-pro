<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { DocumentService, SelectionService } from '@lc/contracts'
import { useAppContext } from '@lc/vue'

const ctx = useAppContext()
const selection = ctx.get<SelectionService>('selection')
const document = ctx.get<DocumentService>('document')

const open = ref(false)
const query = ref('')
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
const version = ref(0)
const disposables: Array<{
  /** 释放该条订阅；卸载时逐条调用，重复调用由注册方保证幂等 */
  dispose(): void
}> = []

function setOpen(next: boolean): void {
  open.value = next
  if (!next) return

  query.value = ''
  activeIndex.value = 0
  void nextTick(() => inputRef.value?.focus())
}

onMounted(() => {
  disposables.push(ctx.on('palette:toggle', () => setOpen(!open.value)))
  disposables.push(
    ctx.command.onDidChange(() => {
      version.value += 1
    }),
  )
  if (selection) {
    disposables.push(
      selection.onDidChange(() => {
        version.value += 1
      }),
    )
  }
  if (document) {
    disposables.push(
      document.onDidChange(() => {
        version.value += 1
      }),
    )
  }
})

onUnmounted(() => {
  for (const disposable of disposables) disposable.dispose()
  disposables.length = 0
})

/** 面板中的一行命令；由命令服务的描述投影而来，只保留渲染需要的四个字段 */
interface PaletteItem {
  /** 命令 id，回车时按它执行 */
  id: string
  /** 命令标题，过滤与展示都用它 */
  title: string
  /** 已绑定的快捷键文案；未绑定为 undefined，右侧不留空位 */
  key: string | undefined
  /** 是否可执行；false 时仍展示但不可选中执行 */
  enabled: boolean
}

const items = computed<PaletteItem[]>(() => {
  version.value
  const keyword = query.value.trim().toLowerCase()
  return ctx.command
    .list()
    .filter((command) => {
      if (!keyword) return true
      return (
        command.title.toLowerCase().includes(keyword) ||
        command.id.toLowerCase().includes(keyword)
      )
    })
    .map((command) => ({
      id: command.id,
      title: command.title,
      key: ctx.keybinding.keyFor(command.id),
      enabled: command.enabled?.() ?? true,
    }))
})

watch(items, () => {
  activeIndex.value = 0
})

function run(id: string): void {
  setOpen(false)
  void ctx.command.execute(id)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    setOpen(false)
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = Math.min(items.value.length - 1, activeIndex.value + 1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = Math.max(0, activeIndex.value - 1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const item = items.value[activeIndex.value]
    if (item?.enabled) run(item.id)
  }
}
</script>

<template>
  <div v-if="open" class="lc-palette" @click.self="setOpen(false)">
    <div class="lc-palette__dialog" role="dialog" aria-label="命令面板">
      <input
        ref="inputRef"
        v-model="query"
        class="lc-palette__input"
        placeholder="搜索命令…"
        @keydown="onKeydown"
      />
      <div class="lc-palette__list">
        <button
          v-for="(item, index) in items"
          :key="item.id"
          type="button"
          class="lc-palette__item"
          :class="{ 'is-active': index === activeIndex }"
          :disabled="!item.enabled"
          @mouseenter="activeIndex = index"
          @click="run(item.id)"
        >
          <span class="lc-palette__title">{{ item.title }}</span>
          <span class="lc-palette__key">{{ item.key ?? '' }}</span>
        </button>
        <div v-if="items.length === 0" class="lc-palette__empty">没有匹配的命令</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lc-palette {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  background: rgba(15, 23, 42, 0.35);
}

.lc-palette__dialog {
  width: min(560px, 90vw);
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 12px;
  background: var(--lc-surface);
  box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28);
}

.lc-palette__input {
  height: 44px;
  padding: 0 16px;
  border: none;
  border-bottom: 1px solid var(--lc-border);
  outline: none;
  font-size: 14px;
  font-family: inherit;
  color: var(--lc-text);
}

.lc-palette__list {
  overflow: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.lc-palette__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--lc-text);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}

.lc-palette__item.is-active {
  background: rgba(37, 99, 235, 0.1);
  color: #1d4ed8;
}

.lc-palette__item:disabled {
  color: var(--lc-border-strong);
  cursor: not-allowed;
}

.lc-palette__key {
  color: var(--lc-text-secondary);
  font-family: monospace;
  font-size: 11px;
}

.lc-palette__empty {
  padding: 18px;
  text-align: center;
  color: var(--lc-text-secondary);
  font-size: 12px;
}
</style>
