<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Context } from '@lc/kernel'
import CanvasPanel from './CanvasPanel.vue'
import ConfigPanel from './ConfigPanel.vue'
import DependencyPanel from './DependencyPanel.vue'
import DiagnosticsPanel from './DiagnosticsPanel.vue'
import EventLogPanel from './EventLogPanel.vue'
import PluginTreePanel from './PluginTreePanel.vue'
import ServiceTablePanel from './ServiceTablePanel.vue'
import { useDevtools } from '../use-devtools'

const props = defineProps<{
  /** 应用根上下文 */
  context: Context
  /** 当前画布上下文；省略时不出现「画布」标签页 */
  canvasContext?: Context | null
}>()

const emit = defineEmits<{
  /** 请求关闭面板；显隐状态由宿主持有 */
  close: []
}>()

type TabId = 'plugins' | 'services' | 'deps' | 'events' | 'config' | 'diagnostics' | 'canvas'

const {
  scopes,
  plugins,
  services,
  dependencies,
  events,
  diagnostics,
  canvasView,
  summary,
  configOf,
  retry,
  unload,
  clearEvents,
} = useDevtools({ root: props.context, canvas: props.canvasContext ?? null })

const activeTab = ref<TabId>('plugins')
const selectedPluginId = ref<string | null>(null)

const tabs = computed<{ id: TabId; label: string; count: number }[]>(() => {
  const list: { id: TabId; label: string; count: number }[] = [
    { id: 'plugins', label: '插件树', count: summary.value.plugins },
    { id: 'services', label: '服务表', count: summary.value.services },
    { id: 'deps', label: '依赖图', count: dependencies.value.blocked.length },
    { id: 'events', label: '事件日志', count: summary.value.events },
    { id: 'config', label: '配置', count: selectedPluginId.value ? 1 : 0 },
    { id: 'diagnostics', label: '诊断', count: summary.value.diagnostics },
  ]
  if (props.canvasContext) list.push({ id: 'canvas', label: '画布', count: 0 })
  return list
})

const activeCount = computed(() => summary.value.states.active)
const failedCount = computed(() => summary.value.states.failed)
const pendingCount = computed(() => summary.value.states.pending)

const configView = computed(() => configOf(selectedPluginId.value))

function selectPlugin(id: string): void {
  selectedPluginId.value = id
  activeTab.value = 'config'
}

function chooseTab(tab: TabId): void {
  activeTab.value = tab
  if (tab === 'config' && !selectedPluginId.value) {
    selectedPluginId.value = plugins.value[0]?.id ?? null
  }
}
</script>

<template>
  <aside class="lc-devtools" aria-label="开发者工具">
    <header class="lc-devtools__header">
      <div class="lc-devtools__title">
        开发者工具
        <span class="lc-devtools__counts">
          <span class="lc-devtools__count lc-devtools__count--active"
            >{{ activeCount }} active</span
          >
          <span v-if="pendingCount" class="lc-devtools__count lc-devtools__count--pending">
            {{ pendingCount }} pending
          </span>
          <span v-if="failedCount" class="lc-devtools__count lc-devtools__count--failed">
            {{ failedCount }} failed
          </span>
          <span class="lc-devtools__count">{{ scopes.length }} 层作用域</span>
        </span>
      </div>
      <button class="lc-devtools__btn" type="button" @click="emit('close')">关闭</button>
    </header>

    <nav class="lc-devtools__tabs" aria-label="devtools 面板">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="lc-devtools__tab"
        :class="{ 'is-active': activeTab === tab.id }"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.id"
        @click="chooseTab(tab.id)"
      >
        {{ tab.label }}
        <span v-if="tab.count" class="lc-devtools__tab-count">{{ tab.count }}</span>
      </button>
    </nav>

    <div class="lc-devtools__body">
      <PluginTreePanel
        v-if="activeTab === 'plugins'"
        :rows="plugins"
        :scopes="scopes"
        :selected-id="selectedPluginId"
        @select="selectPlugin"
        @retry="(id) => retry(id)"
        @unload="(id) => unload(id)"
      />

      <ServiceTablePanel
        v-else-if="activeTab === 'services'"
        :rows="services"
        :scopes="scopes"
      />

      <DependencyPanel
        v-else-if="activeTab === 'deps'"
        :view="dependencies"
        :scopes="scopes"
        :plugins="plugins"
        @select="selectPlugin"
      />

      <EventLogPanel
        v-else-if="activeTab === 'events'"
        :entries="events"
        :plugins="plugins"
        @clear="clearEvents()"
      />

      <ConfigPanel
        v-else-if="activeTab === 'config'"
        :plugins="plugins"
        :view="configView"
        :selected-id="selectedPluginId"
        @update:selected-id="(id) => (selectedPluginId = id)"
      />

      <DiagnosticsPanel v-else-if="activeTab === 'diagnostics'" :records="diagnostics" />

      <CanvasPanel v-else-if="activeTab === 'canvas'" :view="canvasView" />
    </div>
  </aside>
</template>

<style>
/*
 * 面板内共享的视觉原子：七个子面板都要用同一套徽标、表格与按钮，
 * 因此集中声明在这里，并全部收在 `.lc-devtools` 命名空间下，不影响宿主。
 * 子面板自己的特化样式仍写在各自的 scoped style 里。
 */
.lc-devtools {
  --lc-devtools-success: #15803d;
  --lc-devtools-success-surface: #f0fdf4;
  --lc-devtools-warning: #b45309;
  --lc-devtools-warning-surface: #fffbeb;
  --lc-devtools-mono: ui-monospace, 'Cascadia Code', 'SFMono-Regular', Consolas, monospace;

  display: flex;
  flex: none;
  flex-direction: column;
  width: 560px;
  max-width: 92vw;
  height: 100%;
  overflow: hidden;
  border-left: 1px solid var(--lc-border);
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
  color: var(--lc-text);
  font-size: 12px;
}

.lc-devtools__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--lc-border);
  background: var(--lc-surface-sunken);
}

.lc-devtools__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.lc-devtools__counts {
  display: flex;
  gap: 4px;
}

.lc-devtools__count {
  padding: 1px 6px;
  border: 1px solid var(--lc-border);
  border-radius: 999px;
  color: var(--lc-text-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.lc-devtools__count--active {
  border-color: var(--lc-devtools-success);
  background: var(--lc-devtools-success-surface);
  color: var(--lc-devtools-success);
}

.lc-devtools__count--pending {
  border-color: var(--lc-devtools-warning);
  background: var(--lc-devtools-warning-surface);
  color: var(--lc-devtools-warning);
}

.lc-devtools__count--failed {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-devtools__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-devtools__tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: none;
  color: var(--lc-text-secondary);
  font: inherit;
  cursor: pointer;
  transition:
    background-color 120ms,
    color 120ms;
}

.lc-devtools__tab:hover {
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
}

.lc-devtools__tab.is-active {
  border-color: var(--lc-accent);
  background: rgba(37, 99, 235, 0.12);
  color: var(--lc-accent);
}

.lc-devtools__tab-count {
  font-variant-numeric: tabular-nums;
}

.lc-devtools__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.lc-devtools__btn {
  padding: 2px 8px;
  border: 1px solid var(--lc-border-strong);
  border-radius: 6px;
  background: var(--lc-surface);
  color: var(--lc-text);
  font: inherit;
  cursor: pointer;
  transition:
    background-color 120ms,
    border-color 120ms;
}

.lc-devtools__btn:hover {
  border-color: var(--lc-accent);
  background: var(--lc-surface-sunken);
}

.lc-devtools__btn--danger {
  color: var(--lc-danger);
}

.lc-devtools__field {
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--lc-border-strong);
  border-radius: 6px;
  background: var(--lc-surface);
  color: var(--lc-text);
  font: inherit;
}

.lc-devtools__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-devtools__section {
  padding: 8px 12px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-devtools__section:last-child {
  border-bottom: none;
}

.lc-devtools__section-title {
  margin: 0 0 6px;
  color: var(--lc-text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.lc-devtools__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.lc-devtools__table th,
.lc-devtools__table td {
  padding: 3px 6px;
  border-bottom: 1px solid var(--lc-border);
  text-align: left;
  vertical-align: top;
}

.lc-devtools__table th {
  color: var(--lc-text-secondary);
  font-weight: 500;
}

.lc-devtools__table td {
  font-variant-numeric: tabular-nums;
}

.lc-devtools__badge {
  display: inline-block;
  padding: 0 6px;
  border: 1px solid var(--lc-border-strong);
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
}

.lc-devtools__badge--active {
  border-color: var(--lc-devtools-success);
  background: var(--lc-devtools-success-surface);
  color: var(--lc-devtools-success);
}

.lc-devtools__badge--pending,
.lc-devtools__badge--loading,
.lc-devtools__badge--applying,
.lc-devtools__badge--disposing {
  border-color: var(--lc-devtools-warning);
  background: var(--lc-devtools-warning-surface);
  color: var(--lc-devtools-warning);
}

.lc-devtools__badge--failed,
.lc-devtools__badge--disposed {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-devtools__chip {
  display: inline-block;
  margin: 1px 2px 1px 0;
  padding: 0 5px;
  border: 1px solid var(--lc-border);
  border-radius: 4px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-family: var(--lc-devtools-mono);
  font-size: 11px;
}

.lc-devtools__chip--missing {
  border-color: var(--lc-devtools-warning);
  background: var(--lc-devtools-warning-surface);
  color: var(--lc-devtools-warning);
}

.lc-devtools__chip--reserved {
  border-color: var(--lc-accent);
  background: rgba(37, 99, 235, 0.1);
  color: var(--lc-accent);
}

.lc-devtools__mono {
  font-family: var(--lc-devtools-mono);
}

.lc-devtools__muted {
  color: var(--lc-text-secondary);
}

.lc-devtools__error {
  margin-top: 2px;
  color: var(--lc-danger);
  font-family: var(--lc-devtools-mono);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.lc-devtools__empty {
  padding: 16px 12px;
  color: var(--lc-text-secondary);
}

.lc-devtools__code {
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  font-family: var(--lc-devtools-mono);
  font-size: 11px;
  line-height: 1.5;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.lc-devtools :focus-visible {
  outline: 2px solid var(--lc-accent);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .lc-devtools__tab,
  .lc-devtools__btn {
    transition: none;
  }
}
</style>
