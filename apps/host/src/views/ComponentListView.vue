<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { MaterialService } from '@lc/contracts'
import { SchemaPreview, useAppContext, useRegistryList } from '@lc/vue'
import ComponentCreateDialog from '../components/custom-components/ComponentCreateDialog.vue'
import type { CustomComponent } from '../custom-components/custom-components'
import {
  CUSTOM_PLUGIN,
  customComponents,
  isCustomComponentActive,
  previewScopeOf,
  removeCustomComponent,
  setCustomComponentEnabled,
} from '../custom-components/custom-components'

const ctx = useAppContext()
const router = useRouter()
const materials = useRegistryList(() => ctx.get<MaterialService>('material'))

const keyword = ref('')
const pendingDelete = ref<string | null>(null)
/** 展开预览的组件 id；同时只展开一份，避免整页铺满画布 */
const previewId = ref<string | null>(null)
/** 新建弹框；确认后才进画布，所以这里不预占 id */
const createOpen = ref(false)

/** 新建时的占用名清单：内置物料与已有组件都不允许重名 */
const takenNames = computed<readonly string[]>(() => {
  const contributions = materials.value
    .filter((entry) => entry.plugin !== CUSTOM_PLUGIN)
    .map((entry) => entry.name)
  const stored = customComponents.value.map((item) => item.definition.meta.name)
  return [...new Set([...contributions, ...stored])]
})

function openCreate(): void {
  createOpen.value = true
}

/** 定义已落库，带着 id 进画布继续搭蓝图 */
function onCreated(componentId: string): void {
  createOpen.value = false
  void router.push(`/components/${componentId}/edit`)
}

const visible = computed<readonly CustomComponent[]>(() => {
  const query = keyword.value.trim().toLowerCase()
  if (query === '') return customComponents.value

  return customComponents.value.filter((component) => {
    const { name, title, group, description } = component.definition.meta
    return [name, title, group, description ?? ''].some((field) =>
      field.toLowerCase().includes(query),
    )
  })
})

/** 已停用与名字撞车的组件都不会按这份定义生效，列表要直接说清楚原因 */
function isShadowed(component: CustomComponent): boolean {
  return component.enabled && !isCustomComponentActive(component, materials.value)
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function togglePreview(id: string): void {
  previewId.value = previewId.value === id ? null : id
}

function confirmDelete(id: string): void {
  removeCustomComponent(id)
  pendingDelete.value = null
  if (previewId.value === id) previewId.value = null
}

function toggleEnabled(component: CustomComponent): void {
  setCustomComponentEnabled(component.id, !component.enabled)
}
</script>

<template>
  <main class="lc-components">
    <header class="lc-components__head">
      <div class="lc-components__heading">
        <h1 class="lc-components__title">自定义组件</h1>
        <p class="lc-components__hint">
          新建时先在弹框里定好名称、对外属性和事件，确认后进入画布像搭页面一样拖物料；已有组件直接进画布，改结构或改定义都在同一页。保存后注册为物料，任何页面都能拖用。
        </p>
      </div>
      <button type="button" class="lc-components__primary" @click="openCreate">
        + 新建组件
      </button>
    </header>

    <div class="lc-components__toolbar">
      <label class="lc-components__search">
        <span class="lc-components__sr-only">搜索组件</span>
        <input
          v-model="keyword"
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder="按名称、标题或分组筛选"
        />
      </label>
      <span class="lc-components__summary">
        共 {{ customComponents.length }} 个组件，当前显示 {{ visible.length }} 个
      </span>
    </div>

    <div v-if="customComponents.length === 0" class="lc-components__empty">
      <span class="lc-components__empty-title">还没有自定义组件</span>
      <span>把反复出现的卡片、徽标、表头抽成组件，之后所有页面都能直接拖。</span>
      <button type="button" class="lc-components__link" @click="openCreate">
        创建第一个组件
      </button>
    </div>

    <div v-else-if="visible.length === 0" class="lc-components__empty">
      <span class="lc-components__empty-title">没有匹配的组件</span>
      <span>换个关键字，或先去「函数管理」确认你在找的是不是全局函数。</span>
    </div>

    <ul v-else class="lc-components__list">
      <li v-for="component in visible" :key="component.id" class="lc-components__item">
        <div class="lc-components__body">
          <div class="lc-components__item-main">
            <div class="lc-components__item-head">
              <code class="lc-components__name">{{ component.definition.meta.name }}</code>
              <span class="lc-components__label">{{ component.definition.meta.title }}</span>
              <span class="lc-components__tag">{{ component.definition.meta.group }}</span>
              <span class="lc-components__tag">v{{ component.definition.meta.version }}</span>
              <span
                v-if="!component.enabled"
                class="lc-components__tag lc-components__tag--muted"
              >
                已停用
              </span>
              <span
                v-else-if="isShadowed(component)"
                class="lc-components__tag lc-components__tag--warn"
              >
                与同名物料冲突
              </span>
            </div>

            <p v-if="component.definition.meta.description" class="lc-components__desc">
              {{ component.definition.meta.description }}
            </p>

            <span class="lc-components__meta">
              {{ component.definition.props?.length ?? 0 }} 个属性 ·
              {{ Object.keys(component.definition.nodes).length }} 个节点 ·
              {{ formatTime(component.updatedAt) }}
            </span>
          </div>

          <div class="lc-components__item-side">
            <div class="lc-components__actions">
              <button
                type="button"
                class="lc-components__button"
                :aria-expanded="previewId === component.id"
                @click="togglePreview(component.id)"
              >
                {{ previewId === component.id ? '收起预览' : '预览' }}
              </button>

              <RouterLink
                class="lc-components__button"
                :to="`/components/${component.id}/edit`"
              >
                编辑
              </RouterLink>

              <button
                type="button"
                class="lc-components__button"
                @click="toggleEnabled(component)"
              >
                {{ component.enabled ? '停用' : '启用' }}
              </button>

              <template v-if="pendingDelete === component.id">
                <span class="lc-components__confirm">删除？</span>
                <button
                  type="button"
                  class="lc-components__button lc-components__button--danger"
                  @click="confirmDelete(component.id)"
                >
                  确认
                </button>
                <button
                  type="button"
                  class="lc-components__button"
                  @click="pendingDelete = null"
                >
                  取消
                </button>
              </template>
              <button
                v-else
                type="button"
                class="lc-components__button lc-components__button--danger"
                @click="pendingDelete = component.id"
              >
                删除
              </button>
            </div>
          </div>
        </div>

        <div v-if="previewId === component.id" class="lc-components__preview">
          <SchemaPreview
            :node-id="component.definition.nodeId"
            :nodes="component.definition.nodes"
            :scope="previewScopeOf(component)"
          />
          <span class="lc-components__preview-hint">
            预览按属性默认值渲染；画布上的实际取值来自属性面板。
          </span>
        </div>
      </li>
    </ul>

    <ComponentCreateDialog
      :open="createOpen"
      :taken-names="takenNames"
      @close="createOpen = false"
      @created="onCreated"
    />
  </main>
</template>

<style scoped>
.lc-components {
  flex: 1;
  min-height: 0;
  padding: 32px 36px;
  overflow: auto;
}

.lc-components__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 18px;
}

.lc-components__title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 8px;
  color: var(--lc-text);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.4px;
}

.lc-components__title::before {
  content: '';
  width: 3px;
  height: 20px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--lc-accent-bright), var(--lc-accent));
  box-shadow: 0 0 10px var(--lc-glow);
}

.lc-components__hint {
  max-width: 720px;
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.lc-components__primary {
  display: inline-flex;
  flex: none;
  align-items: center;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--lc-accent);
  border-radius: 8px;
  background: linear-gradient(150deg, var(--lc-accent-bright), var(--lc-accent));
  color: #04101f;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}

.lc-components__primary:hover {
  filter: brightness(1.08);
}

.lc-components__toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.lc-components__search {
  flex: 0 1 320px;
}

.lc-components__search input {
  box-sizing: border-box;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--lc-border);
  border-radius: 8px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
}

.lc-components__search input:focus {
  border-color: var(--lc-accent);
  outline: 1px solid var(--lc-accent);
}

.lc-components__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.lc-components__summary {
  color: var(--lc-text-muted);
  font-size: 12px;
}

.lc-components__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 28px 24px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: rgba(6, 17, 33, 0.5);
  color: var(--lc-text-secondary);
  font-size: 13px;
}

.lc-components__empty-title {
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-components__link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--lc-accent-bright);
  font-family: inherit;
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
}

.lc-components__link:hover {
  text-decoration: underline;
}

.lc-components__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-components__item {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(150deg, rgba(10, 30, 61, 0.7), rgba(7, 21, 40, 0.5));
}

.lc-components__body {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.lc-components__item-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.lc-components__item-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.lc-components__name {
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--lc-surface-sunken);
  color: var(--lc-accent-bright);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
}

.lc-components__label {
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-components__tag {
  padding: 1px 7px;
  border: 1px solid var(--lc-border);
  border-radius: 999px;
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-components__tag--muted {
  color: var(--lc-text-muted);
}

.lc-components__tag--warn {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-components__desc {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.55;
}

.lc-components__meta {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-components__item-side {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.lc-components__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.lc-components__confirm {
  align-self: center;
  color: var(--lc-danger);
  font-size: 11px;
}

.lc-components__button {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
  text-decoration: none;
  cursor: pointer;
}

.lc-components__button:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-components__button--danger {
  border-color: var(--lc-danger-border);
  color: var(--lc-danger);
}

.lc-components__button--danger:hover {
  border-color: var(--lc-danger);
  color: var(--lc-danger);
  background: var(--lc-danger-surface);
}

.lc-components__preview {
  position: relative;
  height: 260px;
  padding: 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-canvas-bg);
}

.lc-components__preview-hint {
  position: absolute;
  right: 12px;
  bottom: 10px;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(4, 12, 24, 0.72);
  color: var(--lc-text-muted);
  font-size: 10px;
}

.lc-components :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .lc-components__primary,
  .lc-components__button {
    transition: none;
  }
}
</style>
