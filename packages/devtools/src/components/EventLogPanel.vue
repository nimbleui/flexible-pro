<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EventLogEntry, PluginRow } from '../core/types'
import { formatClock, formatDuration } from '../core/format'

const props = defineProps<{
  /** 事件日志，最新在前 */
  entries: readonly EventLogEntry[]
  /** 全部实例，用于把插件 id 翻译成名字 */
  plugins: readonly PluginRow[]
}>()

const emit = defineEmits<{
  /** 清空日志 */
  clear: []
}>()

/** 单帧预算：超过它的监听器会让这一帧掉帧，表格里标出来。 */
const FRAME_BUDGET_MS = 16

/** 渲染上限：日志按 500 条封顶，但一次画 500 行表格会拖慢面板本身。 */
const MAX_RENDERED = 100

const keyword = ref('')
const onlyErrors = ref(false)

const nameById = computed(() => new Map(props.plugins.map((row) => [row.id, row.name])))

const filtered = computed<EventLogEntry[]>(() => {
  const text = keyword.value.trim().toLowerCase()
  return props.entries.filter((entry) => {
    if (onlyErrors.value && !entry.error) return false
    if (!text) return true
    return entry.name.toLowerCase().includes(text) || (entry.pluginId ?? '').includes(text)
  })
})

const visible = computed(() => filtered.value.slice(0, MAX_RENDERED))

const slowest = computed(() =>
  props.entries.reduce<EventLogEntry | null>(
    (slowestEntry, entry) =>
      slowestEntry === null || entry.duration > slowestEntry.duration ? entry : slowestEntry,
    null,
  ),
)

function ownerLabel(pluginId: string | undefined): string {
  if (!pluginId) return '内核 / 宿主'
  return nameById.value.get(pluginId) ?? pluginId
}
</script>

<template>
  <div>
    <div class="lc-devtools__toolbar">
      <input
        v-model="keyword"
        class="lc-devtools__field"
        type="search"
        placeholder="过滤事件名 / 插件"
      />
      <label class="lc-events__toggle">
        <input v-model="onlyErrors" type="checkbox" />
        只看抛错
      </label>
      <button class="lc-devtools__btn" type="button" @click="emit('clear')">清空</button>
    </div>

    <p class="lc-events__summary lc-devtools__muted">
      共 {{ entries.length }} 条，命中 {{ filtered.length }} 条
      <template v-if="slowest">
        · 最慢 {{ slowest.name }} {{ formatDuration(slowest.duration) }}</template
      >
      <template v-if="filtered.length > MAX_RENDERED">
        · 仅显示最近 {{ MAX_RENDERED }} 条</template
      >
    </p>

    <p v-if="filtered.length === 0" class="lc-devtools__empty">
      还没有事件。操作设计器后，事件总线上的每次监听器执行都会出现在这里。
    </p>

    <table v-else class="lc-devtools__table">
      <thead>
        <tr>
          <th scope="col">时间</th>
          <th scope="col">事件</th>
          <th scope="col">监听者</th>
          <th scope="col">模式</th>
          <th scope="col">耗时</th>
          <th scope="col">共</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="entry in visible"
          :key="entry.seq"
          :class="{ 'is-slow': entry.duration >= FRAME_BUDGET_MS, 'is-error': entry.error }"
        >
          <td class="lc-devtools__mono">{{ formatClock(entry.at) }}</td>
          <td>
            <span class="lc-devtools__mono">{{ entry.name }}</span>
            <div v-if="entry.error" class="lc-devtools__error">{{ entry.error }}</div>
          </td>
          <td>{{ ownerLabel(entry.pluginId) }}</td>
          <td class="lc-devtools__muted">{{ entry.mode }}</td>
          <td class="lc-devtools__mono">{{ formatDuration(entry.duration) }}</td>
          <td class="lc-devtools__muted">{{ entry.listenerCount }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.lc-events__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--lc-text-secondary);
  cursor: pointer;
  white-space: nowrap;
}

.lc-events__summary {
  margin: 0;
  padding: 6px 12px;
  font-size: 11px;
}

/* 超过单帧预算的监听器标黄：这是事件日志里唯一需要一眼看出来的性能信号 */
.lc-devtools__table tr.is-slow td {
  background: var(--lc-devtools-warning-surface);
}

.lc-devtools__table tr.is-error td {
  background: var(--lc-danger-surface);
}
</style>
