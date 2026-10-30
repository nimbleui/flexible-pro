<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DependencyView, DevtoolsScope, PluginRow } from '../core/types'

const props = defineProps<{
  /** 依赖边、阻塞点与等待环 */
  view: DependencyView
  /** 作用域层，用于标题与分组 */
  scopes: readonly DevtoolsScope[]
  /** 全部实例，用于把 id 翻译成名字 */
  plugins: readonly PluginRow[]
}>()

const emit = defineEmits<{
  /** 选中实例 */
  select: [id: string]
}>()

const showOptional = ref(false)
const onlyUnresolved = ref(false)

const nameById = computed(() => new Map(props.plugins.map((row) => [row.id, row.name])))
const scopeLabel = computed(() => new Map(props.scopes.map((scope) => [scope.id, scope.label])))

const edges = computed(() =>
  props.view.edges.filter((edge) => {
    if (!edge.required && !showOptional.value) return false
    if (onlyUnresolved.value && edge.to !== null) return false
    return true
  }),
)

function displayName(id: string): string {
  return nameById.value.get(id) ?? id
}
</script>

<template>
  <div>
    <section v-if="view.cycles.length > 0" class="lc-devtools__section">
      <h3 class="lc-devtools__section-title">等待环</h3>
      <div v-for="(cycle, index) in view.cycles" :key="index" class="lc-dep__cycle">
        <p class="lc-dep__cycle-path">
          <template v-for="(id, position) in cycle" :key="`${id}-${position}`">
            <button class="lc-dep__link" type="button" @click="emit('select', id)">
              {{ displayName(id) }}
            </button>
            <span class="lc-devtools__muted">→</span>
          </template>
          <button class="lc-dep__link" type="button" @click="emit('select', cycle[0])">
            {{ displayName(cycle[0]) }}
          </button>
        </p>
        <p class="lc-devtools__muted">
          互相等待对方提供的服务，缺依赖两侧都不会启动；需要拆开依赖或调整装配顺序。
        </p>
      </div>
    </section>

    <section class="lc-devtools__section">
      <h3 class="lc-devtools__section-title">
        卡住的插件
        <span class="lc-devtools__muted">{{ view.blocked.length }} 个</span>
      </h3>

      <p v-if="view.blocked.length === 0" class="lc-devtools__muted">所有插件都拿到了依赖。</p>

      <ul class="lc-dep__blocked">
        <li v-for="row in view.blocked" :key="row.id" class="lc-dep__blocked-item">
          <div class="lc-dep__blocked-head">
            <span class="lc-devtools__badge" :class="`lc-devtools__badge--${row.state}`">
              {{ row.state }}
            </span>
            <button class="lc-dep__link" type="button" @click="emit('select', row.id)">
              {{ row.name }}
            </button>
            <span class="lc-devtools__muted">{{
              scopeLabel.get(row.scopeId) ?? row.scopeId
            }}</span>
          </div>

          <p v-if="row.error" class="lc-devtools__error">{{ row.error }}</p>

          <div
            v-for="candidate in row.candidates"
            :key="candidate.service"
            class="lc-dep__missing"
          >
            <span class="lc-devtools__chip lc-devtools__chip--missing">{{
              candidate.service
            }}</span>
            <span
              v-if="candidate.providers.length === 0 && candidate.unactivated.length === 0"
              class="lc-devtools__muted"
            >
              没有插件声明提供这个服务
            </span>
            <span
              v-for="provider in candidate.providers"
              :key="provider.id"
              class="lc-dep__provider"
            >
              {{ provider.name }}
              <span v-if="provider.missing.length > 0" class="lc-devtools__muted">
                自己也缺 {{ provider.missing.join(', ') }}
              </span>
            </span>
            <span
              v-for="name in candidate.unactivated"
              :key="`manifest-${name}`"
              class="lc-dep__provider lc-devtools__muted"
            >
              {{ name }}（清单已登记，尚未激活）
            </span>
          </div>
        </li>
      </ul>
    </section>

    <section class="lc-devtools__section">
      <div class="lc-devtools__toolbar lc-dep__toolbar">
        <h3 class="lc-devtools__section-title">依赖边</h3>
        <label class="lc-dep__toggle">
          <input v-model="showOptional" type="checkbox" />
          显示可选依赖
        </label>
        <label class="lc-dep__toggle">
          <input v-model="onlyUnresolved" type="checkbox" />
          只看未解析
        </label>
      </div>

      <p v-if="edges.length === 0" class="lc-devtools__muted">没有符合筛选条件的依赖边。</p>

      <table v-else class="lc-devtools__table">
        <thead>
          <tr>
            <th scope="col">需求方</th>
            <th scope="col">服务</th>
            <th scope="col">提供者</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="edge in edges" :key="`${edge.from}:${edge.service}:${edge.required}`">
            <td>
              {{ edge.fromName }}
              <div class="lc-devtools__muted">
                {{ scopeLabel.get(edge.scopeId) ?? edge.scopeId }}
              </div>
            </td>
            <td>
              <span class="lc-devtools__chip">{{ edge.service }}</span>
              <span v-if="!edge.required" class="lc-devtools__muted">可选</span>
            </td>
            <td>
              <template v-if="edge.to">
                <button class="lc-dep__link" type="button" @click="emit('select', edge.to)">
                  {{ edge.toName }}
                </button>
              </template>
              <span v-else class="lc-devtools__muted">未解析</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.lc-dep__toolbar {
  padding: 0;
  border-bottom: none;
}

.lc-dep__toolbar .lc-devtools__section-title {
  margin: 0;
  flex: 1;
}

.lc-dep__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--lc-text-secondary);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  cursor: pointer;
}

.lc-dep__cycle {
  margin-bottom: 6px;
  padding: 6px 8px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
}

.lc-dep__cycle-path {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin: 0 0 2px;
  font-weight: 600;
}

.lc-dep__cycle p {
  margin: 0;
}

.lc-dep__blocked {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-dep__blocked-item {
  padding: 6px 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
}

.lc-dep__blocked-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lc-dep__missing {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
}

.lc-dep__provider {
  padding: 0 5px;
  border: 1px dashed var(--lc-border-strong);
  border-radius: 4px;
}

.lc-dep__link {
  padding: 0;
  border: none;
  background: none;
  color: var(--lc-accent);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
