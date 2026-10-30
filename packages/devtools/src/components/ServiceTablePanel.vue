<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DevtoolsScope, ServiceRow } from '../core/types'

const props = defineProps<{
  /** 逐层收集的服务条目 */
  rows: readonly ServiceRow[]
  /** 作用域层，用于分组与标题 */
  scopes: readonly DevtoolsScope[]
}>()

const keyword = ref('')

const filtered = computed<ServiceRow[]>(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) return [...props.rows]
  return props.rows.filter(
    (row) =>
      row.name.toLowerCase().includes(text) ||
      row.ownerName.toLowerCase().includes(text) ||
      row.summary.toLowerCase().includes(text),
  )
})

interface ScopeGroup {
  scope: DevtoolsScope
  rows: ServiceRow[]
}

const groups = computed<ScopeGroup[]>(() =>
  props.scopes
    .map((scope) => ({ scope, rows: filtered.value.filter((row) => row.scopeId === scope.id) }))
    .filter((group) => group.rows.length > 0),
)

const reservedCount = computed(() => filtered.value.filter((row) => row.reserved).length)

/** 遮蔽链一句话：最左边是实际生效层，后面依次是被它盖住的下层。 */
function chainText(row: ServiceRow): string {
  return row.chain
    .map(
      (link) =>
        `${link.scopeLabel} / ${link.ownerName}${link.active ? '（生效）' : '（被遮蔽）'}`,
    )
    .join(' › ')
}
</script>

<template>
  <div>
    <div class="lc-devtools__toolbar">
      <input
        v-model="keyword"
        class="lc-devtools__field"
        type="search"
        placeholder="过滤服务 / 提供者"
      />
      <span class="lc-devtools__muted">
        {{ filtered.length }} 条 · {{ reservedCount }} 个保留服务
      </span>
    </div>

    <div v-if="groups.length === 0" class="lc-devtools__empty">没有匹配的服务</div>

    <section v-for="group in groups" :key="group.scope.id" class="lc-devtools__section">
      <h3 class="lc-devtools__section-title">
        {{ group.scope.label }}
        <span class="lc-devtools__muted">{{ group.rows.length }} 条</span>
      </h3>

      <table class="lc-devtools__table">
        <thead>
          <tr>
            <th scope="col">服务</th>
            <th scope="col">提供者</th>
            <th scope="col">版本</th>
            <th scope="col">值</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in group.rows" :key="row.name">
            <td>
              <span class="lc-devtools__chip">{{ row.name }}</span>
              <span v-if="row.reserved" class="lc-devtools__chip lc-devtools__chip--reserved"
                >保留</span
              >
            </td>
            <td>
              {{ row.ownerName }}
              <div class="lc-devtools__muted lc-devtools__mono">{{ row.ownerId }}</div>
            </td>
            <td class="lc-devtools__mono">{{ row.apiVersion }}</td>
            <td>
              {{ row.summary }}
              <div v-if="row.chain.length > 1" class="lc-svc__chain">
                {{ chainText(row) }}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.lc-svc__chain {
  margin-top: 2px;
  color: var(--lc-text-secondary);
  font-size: 11px;
  overflow-wrap: anywhere;
}
</style>
