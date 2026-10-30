<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DiagnosticRecord } from '@lc/kernel'
import { describeError, formatClock, toDisplayJson } from '../core/format'

const props = defineProps<{
  /** 内核诊断记录，最新在后 */
  records: readonly DiagnosticRecord[]
}>()

const keyword = ref('')

const filtered = computed<DiagnosticRecord[]>(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) return [...props.records]
  return props.records.filter(
    (record) =>
      record.scope.toLowerCase().includes(text) || record.message.toLowerCase().includes(text),
  )
})

/** 倒序展示：排查问题时先看最近发生的那条。 */
const ordered = computed(() => [...filtered.value].reverse())

const scopeCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const record of props.records)
    counts.set(record.scope, (counts.get(record.scope) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])
})

function detailText(record: DiagnosticRecord): string | null {
  if (!record.detail) return null
  const entries = Object.entries(record.detail).filter(([key]) => key !== 'scope')
  return entries.length === 0 ? null : toDisplayJson(Object.fromEntries(entries))
}

function stackOf(record: DiagnosticRecord): string | null {
  return record.error instanceof Error && record.error.stack ? record.error.stack : null
}
</script>

<template>
  <div>
    <div class="lc-devtools__toolbar">
      <input
        v-model="keyword"
        class="lc-devtools__field"
        type="search"
        placeholder="过滤区域 / 消息"
      />
      <span class="lc-devtools__muted">{{ filtered.length }} / {{ records.length }} 条</span>
    </div>

    <div v-if="scopeCounts.length > 0" class="lc-diag__scopes">
      <span v-for="[scope, count] in scopeCounts" :key="scope" class="lc-devtools__chip">
        {{ scope }} × {{ count }}
      </span>
    </div>

    <p v-if="ordered.length === 0" class="lc-devtools__empty">
      {{ records.length === 0 ? '还没有诊断记录。' : '没有匹配的诊断记录。' }}
    </p>

    <ul v-else class="lc-diag__list">
      <li
        v-for="record in ordered"
        :key="record.timestamp + record.message"
        class="lc-diag__item"
      >
        <div class="lc-diag__head">
          <span class="lc-devtools__mono lc-devtools__muted">{{
            formatClock(record.timestamp)
          }}</span>
          <span class="lc-devtools__chip lc-devtools__chip--missing">{{ record.scope }}</span>
          <span class="lc-diag__message">{{ record.message }}</span>
        </div>

        <p v-if="record.error !== undefined" class="lc-devtools__error">
          {{ describeError(record.error) }}
        </p>

        <details v-if="detailText(record) || stackOf(record)" class="lc-diag__details">
          <summary>详情</summary>
          <pre v-if="detailText(record)" class="lc-devtools__code">{{
            detailText(record)
          }}</pre>
          <pre v-if="stackOf(record)" class="lc-devtools__code">{{ stackOf(record) }}</pre>
        </details>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.lc-diag__scopes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 12px 0;
}

.lc-diag__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 8px 12px;
  list-style: none;
}

.lc-diag__item {
  padding: 6px 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
}

.lc-diag__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}

.lc-diag__message {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.lc-diag__details {
  margin-top: 4px;
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-diag__details summary {
  cursor: pointer;
}

.lc-diag__details pre + pre {
  margin-top: 4px;
}
</style>
