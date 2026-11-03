<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { CommandService, MaterialEntry, MaterialService } from '@lc/contracts'
import { toMaterialDragType } from '@lc/contracts'
import { LcIcon, LcSearchField, useAppContext } from '@lc/vue'

defineProps<{
  /** 宿主传入的只读上下文；面板实际使用注入的 Context */
  context?: Record<string, unknown>
}>()

/** 物料来源页签；只有「组件库」接了真实数据源，另两个先占位，点击无行为 */
const sourceTabs: ReadonlyArray<{
  /** 页签 id，同时是 v-for key 与 aria 关联用 */
  id: string
  /** 页签文案 */
  label: string
  /** 是否已接入；false 渲染成禁用态并提示尚未接入 */
  available: boolean
}> = [
  { id: 'materials', label: '组件库', available: true },
  { id: 'blocks', label: '区块模板', available: false },
  { id: 'mine', label: '我的组件', available: false },
]

const ctx = useAppContext()
const material = ctx.get<MaterialService>('material')
const command = ctx.get<CommandService>('command')

const version = ref(0)
const query = ref('')

/** 折叠的分组名；整组替换以触发响应式更新 */
const collapsed = ref<ReadonlySet<string>>(new Set<string>())

/** 物料服务的订阅句柄；onMounted 注册、onUnmounted 释放，只保留一条 */
let off: {
  /** 解绑本面板的 material 监听，重复调用不安全 */
  dispose(): void
} | null = null

onMounted(() => {
  if (!material) return
  off = material.onDidChange(() => {
    version.value += 1
  })
})

onUnmounted(() => {
  off?.dispose()
  off = null
})

/**
 * 按 category 分组并已应用搜索过滤的物料。
 *
 * 分组顺序即 `material.list()` 的返回顺序，不额外排序；空串也是一个分组。
 * 搜索命中范围含展示名与物料名，插件用英文命名时宿主仍能按 `lc.stat` 这样的名字搜到。
 */
const groups = computed(() => {
  version.value
  const keyword = query.value.trim().toLowerCase()
  const grouped = new Map<string, MaterialEntry[]>()

  for (const entry of material?.list() ?? []) {
    if (keyword && !`${entry.title} ${entry.name}`.toLowerCase().includes(keyword)) continue
    const list = grouped.get(entry.category) ?? []
    list.push(entry)
    grouped.set(entry.category, list)
  }

  return [...grouped].map(([category, items]) => ({ category, items }))
})

const hasResult = computed(() => groups.value.length > 0)

function toggleGroup(category: string): void {
  const next = new Set(collapsed.value)
  if (next.has(category)) next.delete(category)
  else next.add(category)
  collapsed.value = next
}

function onDragStart(event: DragEvent, entry: MaterialEntry): void {
  // 命令型物料是编辑器入口而不是画布节点，不允许拖出幽灵节点
  if (entry.clickCommand) {
    event.preventDefault()
    return
  }
  if (!event.dataTransfer) return
  event.dataTransfer.setData(toMaterialDragType(entry.name), entry.name)
  event.dataTransfer.setData('text/plain', entry.name)
  event.dataTransfer.effectAllowed = 'copy'
}

function onClick(entry: MaterialEntry): void {
  if (!entry.clickCommand || !command) return
  void command.execute(entry.clickCommand)
}
</script>

<template>
  <div class="lc-materials">
    <div class="lc-materials__header">
      <!-- 只有一个来源接了数据，所以用 aria-current 而不是 tablist：tab 必须指向真实 tabpanel -->
      <div class="lc-materials__tabs">
        <button
          v-for="tab in sourceTabs"
          :key="tab.id"
          type="button"
          class="lc-materials__tab"
          :aria-current="tab.available ? 'true' : undefined"
          :disabled="!tab.available"
          :title="tab.available ? tab.label : `${tab.label}（尚未接入）`"
        >
          {{ tab.label }}
        </button>
      </div>
      <LcSearchField v-model="query" placeholder="搜索组件…" />
    </div>

    <div v-if="!hasResult" class="lc-materials__empty">
      {{ query ? '没有匹配的组件' : '暂无物料贡献' }}
    </div>

    <template v-else>
      <section
        v-for="section in groups"
        :key="section.category"
        class="lc-materials__group"
        :aria-label="section.category"
      >
        <button
          type="button"
          class="lc-materials__group-head"
          :aria-expanded="!collapsed.has(section.category)"
          @click="toggleGroup(section.category)"
        >
          <span class="lc-materials__group-title">{{ section.category }}</span>
          <LcIcon
            class="lc-materials__group-chevron"
            :name="collapsed.has(section.category) ? 'chevronRight' : 'chevronDown'"
            :size="12"
          />
        </button>

        <div v-show="!collapsed.has(section.category)" class="lc-materials__grid">
          <button
            v-for="entry in section.items"
            :key="entry.name"
            type="button"
            class="lc-materials__item"
            :draggable="entry.clickCommand === undefined"
            :class="{ 'lc-materials__item--command': entry.clickCommand !== undefined }"
            :title="entry.clickCommand ? `${entry.title}（点击打开）` : entry.title"
            :data-material="entry.name"
            @click="onClick(entry)"
            @dragstart="onDragStart($event, entry)"
          >
            <span class="lc-materials__chip">
              <LcIcon :name="entry.icon ?? 'square'" :size="18" />
            </span>
            <span class="lc-materials__label">{{ entry.title }}</span>
          </button>
        </div>
      </section>
    </template>

    <p class="lc-materials__hint">拖拽组件到画布空白处或容器内；带入口的组件点击打开编辑器</p>
  </div>
</template>

<style scoped>
.lc-materials {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 12px;
  color: var(--lc-text);
  font-size: 12px;
}

/* 面板容器是滚动条所在，头部吸顶才不会和滚过去的瓦片叠在一起 */
.lc-materials__header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--lc-rail-bg);
}

.lc-materials__tabs {
  display: flex;
  align-items: center;
  gap: 14px;
}

.lc-materials__tab {
  position: relative;
  padding: 4px 0 8px;
  border: 0;
  background: transparent;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease;
}

.lc-materials__tab:hover:not(:disabled) {
  color: var(--lc-text);
}

.lc-materials__tab[aria-current='true'] {
  color: var(--lc-accent-bright);
  font-weight: 600;
}

.lc-materials__tab[aria-current='true']::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--lc-accent-bright), transparent);
  box-shadow: 0 0 10px var(--lc-glow);
}

.lc-materials__tab:disabled {
  color: var(--lc-text-muted);
  cursor: not-allowed;
  opacity: 0.6;
}

.lc-materials__group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px;
}

.lc-materials__group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2px;
  cursor: pointer;
}

.lc-materials__group-head:hover .lc-materials__group-title {
  color: var(--lc-accent-bright);
}

.lc-materials__group-chevron {
  color: var(--lc-text-secondary);
}

.lc-materials__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.lc-materials__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 0 0 8px;
  border: 0;
  border-radius: var(--lc-radius-sm);
  background: transparent;
  color: var(--lc-text);
  font-family: inherit;
  cursor: grab;
  transition:
    background-color 0.15s ease,
    box-shadow 0.15s ease;
}

.lc-materials__item:hover {
  background: var(--lc-accent-soft);
}

.lc-materials__item:focus-visible {
  outline: 1px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

.lc-materials__item--command {
  cursor: pointer;
}

.lc-materials__chip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 46px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-accent-bright);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.lc-materials__item:hover .lc-materials__chip {
  border-color: var(--lc-border-strong);
  box-shadow: inset 0 0 14px rgba(47, 140, 255, 0.16);
}

.lc-materials__label {
  max-width: 100%;
  overflow: hidden;
  color: var(--lc-text-secondary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-materials__item:hover .lc-materials__label {
  color: var(--lc-text);
}

.lc-materials__empty,
.lc-materials__hint {
  margin: 0;
  padding: 0 12px;
  color: var(--lc-text-muted);
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
}

.lc-materials__empty {
  padding: 20px 12px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-sm);
  margin-inline: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .lc-materials__tab,
  .lc-materials__item,
  .lc-materials__chip {
    transition: none;
  }
}
</style>
