<script setup lang="ts">
import type { PluginConfigView, PluginRow } from '../core/types'
import { toDisplayJson } from '../core/format'

defineProps<{
  /** 全部实例，用于下拉选择 */
  plugins: readonly PluginRow[]
  /** 选中实例的配置视图 */
  view: PluginConfigView | null
  /** 当前选中的实例 id */
  selectedId: string | null
}>()

const emit = defineEmits<{
  /** 切换选中实例 */
  'update:selected-id': [id: string | null]
}>()

function onSelect(event: Event): void {
  const id = (event.target as HTMLSelectElement).value
  emit('update:selected-id', id === '' ? null : id)
}

function json(value: unknown): string {
  return toDisplayJson(value)
}
</script>

<template>
  <div>
    <div class="lc-devtools__toolbar">
      <select class="lc-devtools__field" :value="selectedId ?? ''" @change="onSelect">
        <option value="">选择插件实例</option>
        <option v-for="row in plugins" :key="row.id" :value="row.id">
          {{ row.name }} · {{ row.state }} · {{ row.id }}
        </option>
      </select>
    </div>

    <div v-if="!view" class="lc-devtools__empty">选择左侧的插件实例查看它的配置来源。</div>

    <template v-else>
      <section class="lc-devtools__section">
        <h3 class="lc-devtools__section-title">宿主传入的原始配置</h3>
        <pre class="lc-devtools__code">{{ json(view.raw) }}</pre>
      </section>

      <section class="lc-devtools__section">
        <h3 class="lc-devtools__section-title">生效配置（合并 + 校验后）</h3>
        <pre v-if="view.resolved !== undefined" class="lc-devtools__code">{{
          json(view.resolved)
        }}</pre>
        <p v-else class="lc-devtools__muted">
          实例未处于激活状态，配置只在装配时解析一次，因此这里没有结果。参照「原始配置」与下方覆盖来源。
        </p>
      </section>

      <section class="lc-devtools__section">
        <h3 class="lc-devtools__section-title">
          覆盖来源
          <span class="lc-devtools__muted">{{ view.overrides.length }} 层</span>
        </h3>

        <p v-if="view.overrides.length === 0" class="lc-devtools__muted">
          没有 intercept 覆盖，最终配置只来自原始配置与 schema 默认值。
        </p>

        <div
          v-for="override in view.overrides"
          :key="override.scopeId"
          class="lc-cfg__override"
        >
          <div class="lc-cfg__override-head">
            {{ override.label }}
            <span class="lc-devtools__muted lc-devtools__mono">{{ override.scopeId }}</span>
          </div>
          <pre class="lc-devtools__code">{{ json(override.patch) }}</pre>
        </div>

        <p class="lc-cfg__note lc-devtools__muted">
          合并顺序：原始配置 → 各层 intercept（根在前、越靠近实例越优先）→ schema.parse
          补默认值。记录上只保留合并前与解析后两份，中间合并结果不单独展示。
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.lc-cfg__override + .lc-cfg__override {
  margin-top: 6px;
}

.lc-cfg__override-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
  font-weight: 600;
}

.lc-cfg__note {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.5;
}
</style>
