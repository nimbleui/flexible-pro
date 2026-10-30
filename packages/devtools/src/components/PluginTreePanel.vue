<script setup lang="ts">
import { computed } from 'vue'
import type { DevtoolsScope, PluginRow } from '../core/types'
import { formatClock, formatDuration } from '../core/format'

const props = defineProps<{
  /** 展平后的插件树 */
  rows: readonly PluginRow[]
  /** 作用域层，用于分组与标题 */
  scopes: readonly DevtoolsScope[]
  /** 当前选中的实例 id */
  selectedId: string | null
}>()

const emit = defineEmits<{
  /** 选中实例，宿主据此切到配置面板 */
  select: [id: string]
  /** 重新排队卡住的实例 */
  retry: [id: string]
  /** 卸载实例及其子树 */
  unload: [id: string]
}>()

interface ScopeGroup {
  scope: DevtoolsScope
  rows: PluginRow[]
}

const groups = computed<ScopeGroup[]>(() =>
  props.scopes
    .map((scope) => ({ scope, rows: props.rows.filter((row) => row.scopeId === scope.id) }))
    .filter((group) => group.rows.length > 0),
)

/** pending 与 failed 是「装配没跑成」，只有这两种状态值得重试，与内核 retry 的受理范围一致。 */
function canRetry(row: PluginRow): boolean {
  return row.state === 'pending' || row.state === 'failed'
}

function manifestLine(row: PluginRow): string | null {
  const manifest = row.manifest
  if (!manifest) return null
  const parts = [manifest.version, manifest.certification, manifest.executionProfile].filter(
    Boolean,
  )
  if (manifest.contributions.length > 0) {
    parts.push(manifest.contributions.map((item) => `${item.kind}×${item.count}`).join(' '))
  }
  if (manifest.activated) parts.push('已激活')
  return parts.join(' · ')
}
</script>

<template>
  <div class="lc-devtools__tree">
    <div v-if="groups.length === 0" class="lc-devtools__empty">没有插件实例</div>

    <section v-for="group in groups" :key="group.scope.id" class="lc-devtools__section">
      <h3 class="lc-devtools__section-title">
        {{ group.scope.label }}
        <span class="lc-devtools__muted">{{ group.rows.length }} 个实例</span>
      </h3>

      <ul class="lc-tree__list">
        <li
          v-for="row in group.rows"
          :key="row.id"
          class="lc-tree__item"
          :class="{ 'is-selected': row.id === selectedId, 'is-blocked': canRetry(row) }"
          :style="{ paddingLeft: `${8 + row.depth * 16}px` }"
        >
          <button class="lc-tree__main" type="button" @click="emit('select', row.id)">
            <span class="lc-devtools__badge" :class="`lc-devtools__badge--${row.state}`">
              {{ row.state }}
            </span>
            <span class="lc-tree__name">{{ row.manifest?.displayName ?? row.name }}</span>
            <span class="lc-tree__id lc-devtools__muted">{{ row.id }}</span>
          </button>

          <div class="lc-tree__meta">
            <span v-if="manifestLine(row)" class="lc-devtools__muted">{{
              manifestLine(row)
            }}</span>
            <span v-if="row.applyMs !== undefined" class="lc-devtools__muted">
              耗时 {{ formatDuration(row.applyMs) }}
            </span>
            <span v-if="row.activatedAt !== undefined" class="lc-devtools__muted">
              {{ formatClock(row.activatedAt) }}
            </span>
            <span v-if="row.attempts > 1" class="lc-devtools__muted"
              >第 {{ row.attempts }} 次尝试</span
            >
          </div>

          <div v-if="row.required.length > 0 || row.optional.length > 0" class="lc-tree__deps">
            <span class="lc-devtools__muted">依赖</span>
            <span
              v-for="name in row.required"
              :key="`req-${name}`"
              class="lc-devtools__chip"
              :class="{ 'lc-devtools__chip--missing': row.missing.includes(name) }"
            >
              {{ name }}
            </span>
            <span
              v-for="name in row.optional"
              :key="`opt-${name}`"
              class="lc-devtools__chip lc-devtools__muted"
              :title="'可选依赖'"
            >
              {{ name }}?
            </span>
          </div>

          <div v-if="row.owned.length > 0" class="lc-tree__deps">
            <span class="lc-devtools__muted">提供</span>
            <span
              v-for="name in row.owned"
              :key="name"
              class="lc-devtools__chip lc-devtools__chip--reserved"
            >
              {{ name }}
            </span>
          </div>

          <p v-if="row.error" class="lc-devtools__error">{{ row.error }}</p>

          <div class="lc-tree__actions">
            <button
              v-if="canRetry(row)"
              class="lc-devtools__btn"
              type="button"
              @click="emit('retry', row.id)"
            >
              重试
            </button>
            <button
              class="lc-devtools__btn lc-devtools__btn--danger"
              type="button"
              @click="emit('unload', row.id)"
            >
              卸载
            </button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.lc-tree__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-tree__item {
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: var(--lc-radius-sm);
}

.lc-tree__item:hover {
  background: var(--lc-surface-sunken);
}

.lc-tree__item.is-selected {
  border-color: var(--lc-accent);
  background: rgba(37, 99, 235, 0.08);
}

/* 卡住的实例用左侧色条标记，扫一眼就能在长树里定位 */
.lc-tree__item.is-blocked {
  border-left-color: var(--lc-devtools-warning);
  border-left-width: 3px;
}

.lc-tree__main {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.lc-tree__name {
  font-weight: 600;
}

.lc-tree__id {
  font-family: var(--lc-devtools-mono);
  font-size: 11px;
}

.lc-tree__meta,
.lc-tree__deps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 11px;
}

.lc-tree__actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
</style>
