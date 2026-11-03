<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { FilterSelectOption } from './filter-select'

const props = withDefaults(
  defineProps<{
    /** 当前选中值；与 `options[].value` 全等比较，空串表示未选中 */
    modelValue: string
    /** 候选项列表；分组项按 `group` 字段聚合，未分组项归到无标题组 */
    options: readonly FilterSelectOption[]
    /** 未选中时触发器上的文案 @default '请选择' */
    placeholder?: string
    /** 触发器的无障碍名；候选项自身可读，这里只标注控件用途 @default '选择' */
    ariaLabel?: string
    /** 是否禁用；禁用时不响应点击也不打开弹层 @default false */
    disabled?: boolean
  }>(),
  {
    placeholder: '请选择',
    ariaLabel: '选择',
    disabled: false,
  },
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
}>()

let sequence = 0
const instanceId = `lc-filter-select-${(sequence += 1)}`

const open = ref(false)
const query = ref('')
const activeIndex = ref(0)
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const popover = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)

const position = reactive({
  left: 0,
  top: 0,
  width: 240,
  maxHeight: 260,
})

const selected = computed(() =>
  props.options.find((option) => option.value === props.modelValue),
)

const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (keyword === '') return props.options

  return props.options.filter(
    (option) =>
      option.label.toLowerCase().includes(keyword) ||
      option.value.toLowerCase().includes(keyword) ||
      option.group?.toLowerCase().includes(keyword) === true,
  )
})

const groups = computed(() => {
  const grouped = new Map<string, FilterSelectOption[]>()
  for (const option of filtered.value) {
    const key = option.group ?? ''
    const list = grouped.get(key) ?? []
    list.push(option)
    grouped.set(key, list)
  }
  return [...grouped.entries()].map(([group, items]) => ({ group, items }))
})

const activeOption = computed<FilterSelectOption | undefined>(
  () => filtered.value[activeIndex.value],
)

watch(query, () => {
  activeIndex.value = 0
})

watch(filtered, (items) => {
  if (activeIndex.value >= items.length) {
    activeIndex.value = Math.max(0, items.length - 1)
  }
})

watch(
  () => props.modelValue,
  () => {
    if (!open.value) return
    syncActiveToSelected()
  },
)

function syncActiveToSelected(): void {
  const index = filtered.value.findIndex((option) => option.value === props.modelValue)
  activeIndex.value = index >= 0 ? index : 0
}

function reposition(): void {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return

  const width = Math.min(Math.max(rect.width, 240), Math.max(window.innerWidth - 16, 200))
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
  const spaceBelow = window.innerHeight - rect.bottom - 8
  const spaceAbove = rect.top - 8
  const openAbove = spaceBelow < 180 && spaceAbove > spaceBelow
  const maxHeight = Math.min(280, Math.max(120, openAbove ? spaceAbove : spaceBelow))

  position.left = left
  position.width = width
  position.maxHeight = maxHeight
  position.top = openAbove ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4
}

function scrollActiveIntoView(): void {
  void nextTick(() => {
    popover.value
      ?.querySelector<HTMLElement>('.lc-filter-select__option.is-focused')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function openMenu(): void {
  if (props.disabled) return

  open.value = true
  query.value = ''
  syncActiveToSelected()

  void nextTick(() => {
    reposition()
    searchInput.value?.focus()
    scrollActiveIntoView()
  })
}

function closeMenu(): void {
  open.value = false
  query.value = ''
}

function toggleMenu(): void {
  if (open.value) closeMenu()
  else openMenu()
}

function select(option: FilterSelectOption): void {
  emit('update:modelValue', option.value)
  closeMenu()
  trigger.value?.focus()
}

function move(delta: number): void {
  const length = filtered.value.length
  if (length === 0) return
  activeIndex.value = (activeIndex.value + delta + length) % length
  scrollActiveIntoView()
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (activeOption.value) select(activeOption.value)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    closeMenu()
    trigger.value?.focus()
    return
  }
  if (event.key === 'Tab') closeMenu()
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return

  const target = event.target
  if (!(target instanceof Node)) return
  if (root.value?.contains(target) || popover.value?.contains(target)) return

  closeMenu()
}

function onViewportChange(): void {
  if (open.value) reposition()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})
</script>

<template>
  <div ref="root" class="lc-filter-select">
    <button
      ref="trigger"
      type="button"
      class="lc-filter-select__trigger"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="`${instanceId}-popover`"
      :aria-label="ariaLabel"
      :disabled="disabled"
      @click="toggleMenu"
      @keydown.down.prevent="openMenu"
      @keydown.enter.prevent="toggleMenu"
    >
      <span class="lc-filter-select__label" :class="{ 'is-placeholder': !selected }">
        {{ selected?.label ?? placeholder }}
      </span>
      <span class="lc-filter-select__chevron" aria-hidden="true" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        :id="`${instanceId}-popover`"
        ref="popover"
        class="lc-filter-select__popover"
        role="listbox"
        :aria-label="ariaLabel"
        :style="{
          left: `${position.left}px`,
          top: `${position.top}px`,
          width: `${position.width}px`,
          maxHeight: `${position.maxHeight}px`,
        }"
      >
        <div class="lc-filter-select__search">
          <input
            ref="searchInput"
            v-model="query"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="筛选选项…"
            aria-label="筛选选项"
            @keydown="onSearchKeydown"
          />
        </div>

        <div class="lc-filter-select__options">
          <template v-if="filtered.length > 0">
            <div v-for="group in groups" :key="group.group" class="lc-filter-select__group">
              <div v-if="group.group" class="lc-filter-select__group-label">
                {{ group.group }}
              </div>
              <button
                v-for="option in group.items"
                :key="option.value"
                type="button"
                class="lc-filter-select__option"
                :class="{
                  'is-selected': option.value === modelValue,
                  'is-focused': option.value === activeOption?.value,
                }"
                role="option"
                :aria-selected="option.value === modelValue"
                @mouseenter="activeIndex = filtered.indexOf(option)"
                @click="select(option)"
              >
                <span class="lc-filter-select__option-label">{{ option.label }}</span>
                <span v-if="option.description" class="lc-filter-select__option-desc">
                  {{ option.description }}
                </span>
              </button>
            </div>
          </template>
          <div v-else class="lc-filter-select__empty">没有匹配项</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.lc-filter-select {
  position: relative;
  min-width: 0;
}

.lc-filter-select *,
.lc-filter-select *::before,
.lc-filter-select *::after,
.lc-filter-select__popover *,
.lc-filter-select__popover *::before,
.lc-filter-select__popover *::after {
  box-sizing: border-box;
}

.lc-filter-select__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.lc-filter-select__trigger:hover:not(:disabled) {
  border-color: var(--lc-border-strong);
}

.lc-filter-select__trigger:focus-visible {
  border-color: var(--lc-accent);
  outline: 1px solid var(--lc-accent);
}

.lc-filter-select__trigger:disabled {
  color: var(--lc-text-muted);
  cursor: not-allowed;
  opacity: 0.65;
}

.lc-filter-select__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-filter-select__label.is-placeholder {
  color: var(--lc-text-muted);
}

.lc-filter-select__chevron {
  flex: none;
  width: 0;
  height: 0;
  border-top: 4px solid currentColor;
  border-right: 4px solid transparent;
  border-left: 4px solid transparent;
  opacity: 0.7;
}

.lc-filter-select__popover {
  position: fixed;
  z-index: 1400;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--lc-border-strong);
  border-radius: 8px;
  background: var(--lc-surface);
  box-shadow: 0 16px 40px rgba(0, 6, 18, 0.62);
  color: var(--lc-text);
  font-size: 11px;
}

.lc-filter-select__search {
  flex: none;
  padding: 6px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-filter-select__search input {
  width: 100%;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--lc-border);
  border-radius: 5px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
}

.lc-filter-select__search input:focus {
  border-color: var(--lc-accent);
  outline: 1px solid var(--lc-accent);
}

.lc-filter-select__options {
  flex: 1;
  min-height: 0;
  padding: 4px;
  overflow-y: auto;
}

.lc-filter-select__group-label {
  padding: 6px 8px 3px;
  color: var(--lc-text-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.lc-filter-select__option {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.lc-filter-select__option.is-focused {
  background: var(--lc-accent-soft);
}

.lc-filter-select__option.is-selected {
  color: var(--lc-accent-bright);
}

.lc-filter-select__option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-filter-select__option-desc {
  overflow: hidden;
  color: var(--lc-text-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-filter-select__empty {
  padding: 14px 8px;
  color: var(--lc-text-muted);
  font-size: 11px;
  text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .lc-filter-select__trigger {
    transition: none;
  }
}
</style>
