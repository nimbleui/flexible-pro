<script setup lang="ts">
import { useDataBindingPanel } from './composables/use-data-binding-panel'
import { BINDING_KIND_LABELS } from './utils/binding-scan'

defineProps<{
  /** 宿主传入的只读上下文；面板自己从注入的 Context 取服务 */
  context?: Record<string, unknown>
}>()

const {
  bindings,
  groupedRows,
  isUnresolved,
  locateBindingNode,
  openDataDialog,
  refreshSource,
  selectBinding,
  selectItem,
  selectedBinding,
  selectedBindingIndex,
  selectedLabel,
  selectedPath,
  sourceStatusText,
  sourceStatusTone,
  syntaxIssues,
  unresolved,
  unused,
  visibleBindings,
} = useDataBindingPanel()
</script>

<template>
  <div class="lc-data">
    <!-- 左：数据项清单 -->
    <aside class="lc-data__items" aria-label="数据项">
      <div class="lc-data__column-head">
        <span class="lc-data__column-title">数据项</span>
        <button class="lc-data__button" type="button" @click="openDataDialog">
          编辑页面数据
        </button>
      </div>

      <div class="lc-data__scroll">
        <button
          type="button"
          class="lc-data__item"
          :class="{ 'is-active': selectedPath === '' }"
          @click="selectedPath = ''"
        >
          <span class="lc-data__item-name">全部绑定</span>
          <span class="lc-data__count">{{ bindings.length }}</span>
        </button>

        <section v-for="group in groupedRows" :key="group.kind" class="lc-data__group">
          <p class="lc-data__group-title">{{ group.label }}</p>

          <div v-for="row in group.items" :key="row.path" class="lc-data__row">
            <button
              type="button"
              class="lc-data__item"
              :class="{ 'is-active': selectedPath === row.path }"
              :title="row.description || row.path"
              @click="selectItem(row.path)"
            >
              <span class="lc-data__item-main">
                <code class="lc-data__item-path">{{ row.path }}</code>
                <span class="lc-data__item-detail">{{ row.detail }}</span>
                <span v-if="row.value" class="lc-data__item-value">{{ row.value }}</span>
              </span>
              <span
                class="lc-data__count"
                :class="{ 'is-zero': row.references === 0 }"
                :title="
                  row.references === 0 ? '没有任何绑定读它' : `${row.references} 条绑定引用`
                "
              >
                {{ row.references }}
              </span>
            </button>

            <button
              v-if="row.kind === 'source'"
              type="button"
              class="lc-data__tool"
              :data-tone="sourceStatusTone(row.name)"
              :disabled="sourceStatusTone(row.name) === 'loading'"
              :title="sourceStatusText(row.name)"
              :aria-label="`重新请求 ${row.name}`"
              @click="refreshSource(row.name)"
            >
              ↻
            </button>
          </div>
        </section>

        <p v-if="groupedRows.length === 0" class="lc-data__note">
          还没有数据项。变量与接口数据在「页面数据」里声明，声明后会自动出现在这里。
        </p>
      </div>
    </aside>

    <!-- 中：绑定表 -->
    <section class="lc-data__table" aria-label="绑定列表">
      <div class="lc-data__column-head">
        <span class="lc-data__column-title">{{ selectedLabel }}</span>
        <span class="lc-data__column-meta">{{ visibleBindings.length }} 条</span>
      </div>

      <div class="lc-data__grid">
        <div class="lc-data__thead" aria-hidden="true">
          <span>节点</span>
          <span>位置</span>
          <span>表达式</span>
          <span>引用</span>
        </div>

        <ul class="lc-data__scroll">
          <li v-for="(binding, index) in visibleBindings" :key="`${binding.field}-${index}`">
            <button
              type="button"
              class="lc-data__binding"
              :class="{ 'is-active': selectedBindingIndex === index }"
              :aria-pressed="selectedBindingIndex === index"
              @click="selectBinding(index)"
            >
              <span class="lc-data__binding-cell">{{ binding.nodeLabel }}</span>
              <span class="lc-data__binding-cell">
                {{ BINDING_KIND_LABELS[binding.kind] }}
                <code>{{ binding.field }}</code>
              </span>
              <code class="lc-data__binding-cell lc-data__expression">{{
                binding.expression
              }}</code>
              <span class="lc-data__binding-cell lc-data__refs">
                <span
                  v-for="ref in binding.refs.slice(0, 3)"
                  :key="ref.path"
                  class="lc-data__chip"
                  :class="{ 'is-bad': isUnresolved(ref.path) }"
                >
                  {{ ref.path }}
                </span>
                <span v-if="binding.unsafe" class="lc-data__chip is-raw">原生代码</span>
                <span v-if="binding.refs.length > 3" class="lc-data__chip">
                  +{{ binding.refs.length - 3 }}
                </span>
              </span>
            </button>
          </li>
        </ul>

        <p v-if="visibleBindings.length === 0" class="lc-data__note">
          这个范围里没有任何动态绑定。属性写成固定值不会产生绑定。
        </p>
      </div>
    </section>

    <!-- 右：详情与体检 -->
    <aside class="lc-data__detail" aria-label="绑定详情">
      <div class="lc-data__column-head">
        <span class="lc-data__column-title">{{
          selectedBinding ? '绑定详情' : '数据体检'
        }}</span>
      </div>

      <div class="lc-data__scroll">
        <template v-if="selectedBinding">
          <dl class="lc-data__facts">
            <div>
              <dt>节点</dt>
              <dd>{{ selectedBinding.nodeLabel || '页面级' }}</dd>
            </div>
            <div>
              <dt>位置</dt>
              <dd>{{ selectedBinding.field }}</dd>
            </div>
          </dl>

          <pre class="lc-data__code">{{ selectedBinding.expression }}</pre>

          <p v-if="selectedBinding.unsafe" class="lc-data__warn">
            这段是白名单之外的原生 JS，面板不解析它的引用。
          </p>

          <ul v-if="selectedBinding.refs.length" class="lc-data__reflist">
            <li v-for="ref in selectedBinding.refs" :key="ref.path">
              <code>{{ ref.path }}</code>
              <span v-if="ref.dynamic" class="lc-data__hint">下标动态，路径到此为止</span>
            </li>
          </ul>

          <p
            v-for="issue in syntaxIssues"
            :key="issue.message"
            class="lc-data__warn"
            role="alert"
          >
            语法：{{ issue.message }}
          </p>

          <button
            v-if="selectedBinding.nodeId"
            type="button"
            class="lc-data__button lc-data__button--primary"
            @click="locateBindingNode"
          >
            在画布上选中
          </button>
        </template>

        <template v-else>
          <section class="lc-data__block">
            <h3 class="lc-data__block-title">未声明的数据引用</h3>
            <p v-if="unresolved.length === 0" class="lc-data__ok">没有发现问题。</p>
            <ul v-else class="lc-data__issues">
              <li v-for="(issue, index) in unresolved" :key="`${issue.path}-${index}`">
                <code>{{ issue.path }}</code>
                <span>{{ issue.binding.nodeLabel }} · {{ issue.binding.field }}</span>
              </li>
            </ul>
          </section>

          <section class="lc-data__block">
            <h3 class="lc-data__block-title">没人读的数据项</h3>
            <p v-if="unused.length === 0" class="lc-data__ok">每一项都至少被一条绑定引用。</p>
            <ul v-else class="lc-data__issues">
              <li v-for="name in unused" :key="name">
                <code>data.{{ name }}</code>
              </li>
            </ul>
            <p class="lc-data__hint">
              出现动态下标（如 <code>data[key]</code>）时这项检查整体跳过，避免误报。
            </p>
          </section>
        </template>
      </div>
    </aside>
  </div>
</template>

<style scoped src="./styles/base.css"></style>
<style scoped src="./styles/items.css"></style>
<style scoped src="./styles/table.css"></style>
<style scoped src="./styles/detail.css"></style>
<style scoped src="./styles/states.css"></style>
