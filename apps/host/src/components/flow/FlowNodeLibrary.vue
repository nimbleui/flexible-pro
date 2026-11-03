<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FlowNodeCatalogEntry, FlowNodeCategory } from '@lc/schema'
import { FLOW_NODE_CATALOG, FLOW_NODE_CATEGORY_LABELS } from '@lc/schema'
import { FLOW_CATEGORY_FILTERS, FLOW_CATEGORY_ORDER } from './constants/node-tone'
import './styles/library.css'

/**
 * 流程编排左栏的节点组件库。
 *
 * 只负责「展示目录 + 表达意图」：落点换算、幽灵绘制、写入文档都由外壳与
 * `use-flow-editor` 承担，所以这里不持有任何图状态，重复点击也不需要去重——
 * 在条目上按下指针会先派发 `drag-start`，原地松手还会补一次 `add`，由外壳决定采纳哪个。
 */
const emit = defineEmits<{
  /** 单击条目：请求在视口中心落点新建节点，参数是 FLOW_NODE_CATALOG 条目的 key */
  add: [catalogKey: string]
  /**
   * 在条目上按下指针：请求开始一次拖拽插入，视图层负责画幽灵与落点换算。
   *
   * 名字必须是 kebab-case 的 `drag-start`：模板写 `@drag-start` 时 Vue 生成的 prop 是
   * `onDragStart`，而派发 `dragstart` 找的是 `onDragstart`，两者对不上会静默失联——
   * 表现就是拖拽整条路径没有任何报错地不生效。
   */
  'drag-start': [payload: { catalogKey: string; clientX: number; clientY: number }]
  /** 面板头部的关闭按钮 */
  close: []
}>()

const keyword = ref('')
const activeCategory = ref<FlowNodeCategory | 'all'>('all')
const collapsedGroups = ref<Partial<Record<FlowNodeCategory, boolean>>>({})

const query = computed(() => keyword.value.trim().toLowerCase())

const matched = computed(() =>
  FLOW_NODE_CATALOG.filter((entry) => {
    if (activeCategory.value !== 'all' && entry.category !== activeCategory.value) return false
    if (!query.value) return true

    return (
      entry.title.toLowerCase().includes(query.value) ||
      entry.description.toLowerCase().includes(query.value)
    )
  }),
)

/** 计数按筛选后的结果集算，与用户实际看到的条目数保持一致 */
const groups = computed(() =>
  FLOW_CATEGORY_ORDER.map((category) => ({
    category,
    label: FLOW_NODE_CATEGORY_LABELS[category],
    entries: matched.value.filter((entry) => entry.category === category),
  })).filter((group) => group.entries.length > 0),
)

const isSearching = computed(() => query.value !== '')

/** 搜索时强制展开：命中项藏在收起的分组里会被误读成「没有匹配」 */
function isCollapsed(category: FlowNodeCategory): boolean {
  return isSearching.value ? false : collapsedGroups.value[category] === true
}

function toggleGroup(category: FlowNodeCategory): void {
  collapsedGroups.value = {
    ...collapsedGroups.value,
    [category]: !isCollapsed(category),
  }
}

function onPointerDown(entry: FlowNodeCatalogEntry, event: PointerEvent): void {
  // 只认主指针：右键留给浏览器菜单，中键留给系统滚动，都不该起拖
  if (event.button !== 0) return

  emit('drag-start', { catalogKey: entry.key, clientX: event.clientX, clientY: event.clientY })
}
</script>

<template>
  <div class="lc-flow-library">
    <header class="lc-flow-library__head">
      <h2 class="lc-flow-library__title">节点组件</h2>
      <button
        type="button"
        class="lc-icon-button lc-flow-library__close"
        aria-label="关闭节点组件面板"
        title="关闭"
        @click="emit('close')"
      >
        <span aria-hidden="true">×</span>
      </button>
    </header>

    <label class="lc-flow-library__search">
      <span class="lc-flow-library__sr-only">搜索节点</span>
      <input
        v-model="keyword"
        class="lc-flow-library__input"
        type="search"
        autocomplete="off"
        spellcheck="false"
        placeholder="搜索节点…"
      />
    </label>

    <div class="lc-flow-library__chips" role="group" aria-label="按分组筛选节点">
      <button
        v-for="filter in FLOW_CATEGORY_FILTERS"
        :key="filter.value"
        type="button"
        class="lc-flow-library__chip"
        :class="{ 'is-active': activeCategory === filter.value }"
        :aria-pressed="activeCategory === filter.value"
        @click="activeCategory = filter.value"
      >
        {{ filter.label }}
      </button>
    </div>

    <div class="lc-flow-library__body">
      <p v-if="groups.length === 0" class="lc-flow-library__empty" role="status">
        没有匹配的节点，换个关键词或选择「全部」
      </p>

      <section v-for="group in groups" :key="group.category" class="lc-flow-library__group">
        <button
          type="button"
          class="lc-flow-library__group-head"
          :class="{ 'is-collapsed': isCollapsed(group.category) }"
          :aria-expanded="!isCollapsed(group.category)"
          :aria-controls="`lc-flow-library-group-${group.category}`"
          @click="toggleGroup(group.category)"
        >
          <span class="lc-flow-library__caret" aria-hidden="true"></span>
          <span class="lc-flow-library__group-label">{{ group.label }}</span>
          <span class="lc-flow-library__group-count">{{ group.entries.length }}</span>
        </button>

        <ul
          v-show="!isCollapsed(group.category)"
          :id="`lc-flow-library-group-${group.category}`"
          class="lc-flow-library__grid"
          role="list"
        >
          <li v-for="entry in group.entries" :key="entry.key">
            <button
              type="button"
              class="lc-flow-library__entry"
              :data-category="entry.category"
              :title="entry.description"
              @pointerdown="onPointerDown(entry, $event)"
              @click="emit('add', entry.key)"
            >
              <span class="lc-flow-library__icon" aria-hidden="true"></span>
              <span class="lc-flow-library__entry-title">{{ entry.title }}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
