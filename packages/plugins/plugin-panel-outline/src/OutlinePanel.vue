<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Disposable } from '@lc/kernel'
import type { DocumentService, MaterialService, SelectionService } from '@lc/contracts'
import type { NodePosition, NodeSchema, OutlineItem, SchemaPatch } from '@lc/schema'
import {
  buildOutlineTree,
  filterOutlineTree,
  renameNode,
  reorderChildren,
  setNodeFlags,
} from '@lc/schema'
import { LcIcon, LcSearchField, useAppContext } from '@lc/vue'

defineProps<{
  /** 宿主传入的只读上下文；面板自己从注入的 Context 取服务 */
  context?: Record<string, unknown>
}>()

const ctx = useAppContext()
const document = ctx.get<DocumentService>('document')
const selection = ctx.get<SelectionService>('selection')
const material = ctx.get<MaterialService>('material')

/** 行高与样式里的 .lc-outline__item 高度一致：落点只按上半 / 下半判断，不需要量 DOM */
const ROW_HEIGHT = 28

const version = ref(0)
const disposables: Disposable[] = []

/** 折叠的节点 id；整组替换以触发响应式更新 */
const collapsed = ref<ReadonlySet<string>>(new Set<string>())
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const query = ref('')

/** 拖拽重排的三个瞬时状态：被拖行、目标行、目标行之前还是之后 */
const draggingId = ref<string | null>(null)
const dropKey = ref<string | null>(null)
const dropAfter = ref(false)

const bump = (): void => {
  version.value += 1
}

onMounted(() => {
  if (document) disposables.push(document.onDidChange(bump))
  if (selection) disposables.push(selection.onDidChange(bump))
})

onUnmounted(() => {
  for (const disposable of disposables) disposable.dispose()
  disposables.length = 0
})

/** 图层行：树结构展平后的渲染单元 */
interface LayerRow {
  /** 行 key，等于节点 id；展平后同一棵树里 id 唯一，可直接作 v-for key */
  key: string
  /** 节点本体，引用 schema 里的对象，不做副本 */
  node: NodeSchema
  /** 缩进层级；根节点为 0，每下钻一层 +1 */
  depth: number
  /** 是否有子节点；决定展开箭头是否出现，与当前折叠状态无关 */
  expandable: boolean
  /** 自身子树是否展开；只由折叠集合取反，父级被折叠时这一行根本不会出现在结果里 */
  expanded: boolean
  /** 是否在当前选中集里；多选时多个行同时为 true */
  selected: boolean
  /** 行图标名；容器一律 folder，叶子按 componentName 回查物料声明 */
  icon: string
  /** 在父级数组中的位置；根节点与游离节点没有 */
  position?: NodePosition
}

/**
 * componentName → 物料图标名。
 *
 * 大纲与组件库面板没有共用组件实例，只能各自查一次物料表；
 * 读的是同一份 MaterialService 贡献，所以物料改名后两边不会分叉。
 */
const iconByComponent = computed(() => {
  version.value
  const map = new Map<string, string>()
  for (const entry of material?.list() ?? []) {
    if (entry.icon) map.set(entry.name, entry.icon)
  }
  return map
})

/** 过滤后的图层树；关键词为空时原样返回，所以这里不需要「是否在搜」的分支 */
const tree = computed<OutlineItem[]>(() => {
  version.value
  if (!document) return []
  return filterOutlineTree(buildOutlineTree(document.model.schema), query.value)
})

/** 搜索态强制展开：命中的后代要看得见，此时折叠集合不参与 */
const isSearching = computed(() => query.value.trim().length > 0)

const rows = computed<LayerRow[]>(() => {
  const searching = isSearching.value
  const result: LayerRow[] = []
  const selectedIds = new Set(selection?.ids ?? [])

  const walk = (item: OutlineItem, depth: number): void => {
    const expandable = item.children.length > 0
    const expanded = searching ? true : !collapsed.value.has(item.node.id)
    result.push({
      key: item.node.id,
      node: item.node,
      depth,
      expandable,
      expanded,
      selected: selectedIds.has(item.node.id),
      icon: expandable
        ? 'folder'
        : (iconByComponent.value.get(item.node.componentName) ?? 'square'),
      position: item.position,
    })
    if (!expandable || !expanded) return
    for (const child of item.children) walk(child, depth + 1)
  }

  for (const item of tree.value) walk(item, 0)
  return result
})

function apply(patches: SchemaPatch[], label: string): void {
  if (!document || patches.length === 0) return
  document.apply(patches, { record: true, label })
}

function toggleExpand(nodeId: string): void {
  const next = new Set(collapsed.value)
  if (next.has(nodeId)) next.delete(nodeId)
  else next.add(nodeId)
  collapsed.value = next
}

/**
 * 点选行为与画布一致：普通点击替换选中集，Shift 点击追加 / 取消单个。
 *
 * 图层树是唯一能选中锁定节点的地方，所以这里不看锁定状态。
 */
function selectRow(row: LayerRow, event: MouseEvent): void {
  if (!selection) return
  if (event.shiftKey) selection.toggle(row.node.id)
  else selection.set([row.node.id])
}

function toggleFlag(row: LayerRow, field: 'hidden' | 'locked'): void {
  if (!document) return
  const next = row.node[field] !== true
  const flags = field === 'hidden' ? { hidden: next } : { locked: next }
  apply(setNodeFlags(document.model.schema, [row.node.id], flags), flagLabel(field, next))
}

function flagLabel(field: 'hidden' | 'locked', on: boolean): string {
  if (field === 'hidden') return on ? '隐藏节点' : '显示节点'
  return on ? '锁定节点' : '解锁节点'
}

function startRename(row: LayerRow): void {
  renamingId.value = row.node.id
  renameValue.value = row.node.name ?? ''
}

function commitRename(): void {
  const nodeId = renamingId.value
  if (nodeId === null) return
  renamingId.value = null
  if (!document) return
  apply(renameNode(document.model.schema, nodeId, renameValue.value), '重命名图层')
}

/** Esc 取消：只收编辑态，不写文档 */
function cancelRename(): void {
  renamingId.value = null
}

function onDragStart(row: LayerRow, event: DragEvent): void {
  // 根节点与游离节点没有父级数组可重排
  if (!row.position || !event.dataTransfer) {
    event.preventDefault()
    return
  }
  draggingId.value = row.node.id
  event.dataTransfer.effectAllowed = 'move'
  // 浏览器只按类型判断能否放置，内容不参与逻辑：目标行本身就带着位置
  event.dataTransfer.setData('application/x-lc-layer', row.node.id)
}

/** 同一个父级数组内部才允许重排：跨父级搬运属于结构变更，不在图层树里顺手做 */
function canDropOn(row: LayerRow): boolean {
  const source = sourcePosition()
  if (!source || !row.position) return false
  if (draggingId.value === row.node.id) return false
  return source.parentId === row.position.parentId && source.slot === row.position.slot
}

function sourcePosition(): NodePosition | undefined {
  const dragged = draggingId.value
  if (!dragged) return undefined
  return rows.value.find((row) => row.node.id === dragged)?.position
}

function onDragOver(row: LayerRow, event: DragEvent): void {
  if (!canDropOn(row) || !event.dataTransfer) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  dropKey.value = row.key
  dropAfter.value = event.offsetY > ROW_HEIGHT / 2
}

function onDrop(row: LayerRow): void {
  const source = sourcePosition()
  const target = row.position
  const after = dropAfter.value
  resetDrag()
  if (!document || !source || !target) return

  // 插入下标先按原数组算，再换算成「移除被拖行之后」的下标：
  // reorderChildren 是先移除再插入语义，被拖元素在目标前面时下标要减一
  const raw = after ? target.index + 1 : target.index
  const to = raw > source.index ? raw - 1 : raw
  if (to === source.index) return

  apply(
    reorderChildren(document.model.schema, {
      parentId: source.parentId,
      slot: source.slot,
      from: source.index,
      to,
    }),
    '调整图层顺序',
  )
}

function resetDrag(): void {
  draggingId.value = null
  dropKey.value = null
  dropAfter.value = false
}

const hasDocument = computed(() => Boolean(document && selection))
</script>

<template>
  <div v-if="!hasDocument" class="lc-outline lc-outline--empty">未打开文档</div>
  <div v-else class="lc-outline">
    <div class="lc-outline__header">
      <LcSearchField v-model="query" placeholder="搜索节点…" />
      <p class="lc-outline__hint">顺序：底层 → 顶层</p>
    </div>
    <ul v-if="rows.length" class="lc-outline__list">
      <li
        v-for="row in rows"
        :key="row.key"
        class="lc-outline__item"
        :data-node-id="row.node.id"
        :class="{
          'is-selected': row.selected,
          'is-drop-before': dropKey === row.key && !dropAfter,
          'is-drop-after': dropKey === row.key && dropAfter,
          'is-muted': row.node.hidden === true,
        }"
        :style="{ paddingLeft: `${6 + row.depth * 14}px` }"
        :draggable="row.position !== undefined"
        @click="selectRow(row, $event)"
        @dblclick="startRename(row)"
        @dragstart="onDragStart(row, $event)"
        @dragover="onDragOver(row, $event)"
        @drop="onDrop(row)"
        @dragend="resetDrag"
      >
        <button
          v-if="row.expandable"
          class="lc-outline__chevron"
          type="button"
          :aria-label="row.expanded ? '折叠' : '展开'"
          @click.stop="toggleExpand(row.node.id)"
        >
          <LcIcon :name="row.expanded ? 'chevronDown' : 'chevronRight'" :size="12" />
        </button>
        <span v-else class="lc-outline__chevron lc-outline__chevron--placeholder" />

        <span class="lc-outline__icon">
          <LcIcon :name="row.icon" :size="14" />
        </span>

        <input
          v-if="renamingId === row.node.id"
          class="lc-outline__input"
          :value="renameValue"
          autofocus
          @click.stop
          @input="renameValue = ($event.target as HTMLInputElement).value"
          @keyup.enter="commitRename"
          @keyup.esc="cancelRename"
          @blur="commitRename"
        />
        <span v-else class="lc-outline__label">{{
          row.node.name ?? row.node.componentName
        }}</span>

        <span class="lc-outline__actions">
          <button
            class="lc-outline__flag"
            type="button"
            :title="row.node.hidden ? '显示节点' : '隐藏节点'"
            :aria-pressed="row.node.hidden === true"
            @click.stop="toggleFlag(row, 'hidden')"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M1.5 8s2.5-3.5 6.5-3.5S14.5 8 14.5 8 12 11.5 8 11.5 1.5 8 1.5 8Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
              />
              <circle
                cx="8"
                cy="8"
                r="1.8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
              />
              <path
                v-if="row.node.hidden"
                d="M3 13L13 3"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <button
            class="lc-outline__flag"
            type="button"
            :title="row.node.locked ? '解锁节点' : '锁定节点'"
            :aria-pressed="row.node.locked === true"
            @click.stop="toggleFlag(row, 'locked')"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect
                x="3.5"
                y="7"
                width="9"
                height="6.5"
                rx="1.2"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
              />
              <path
                :d="
                  row.node.locked
                    ? 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2'
                    : 'M5.5 7V5a2.5 2.5 0 0 1 4.5-1.5'
                "
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
              />
            </svg>
          </button>
        </span>
      </li>
    </ul>
    <div v-else class="lc-outline__empty">
      {{ query ? '没有匹配的节点' : '页面还没有节点' }}
    </div>
  </div>
</template>

<style scoped>
.lc-outline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 8px;
  font-size: 12px;
  color: var(--lc-text);
}

.lc-outline--empty {
  padding: 12px;
  color: var(--lc-text-secondary);
}

/* 浮动面板的滚动条在容器上：搜索与顺序提示吸顶，滚动的树从它下面穿过 */
.lc-outline__header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 0 8px;
  background: var(--lc-rail-bg);
}

.lc-outline__hint {
  margin: 0;
  padding: 0 2px;
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-outline__empty {
  margin-top: 8px;
  padding: 16px 12px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-sm);
  color: var(--lc-text-secondary);
  font-size: 11px;
  text-align: center;
}

.lc-outline__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-outline__item {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding-right: 4px;
  border: 1px solid transparent;
  border-radius: var(--lc-radius-sm);
  cursor: pointer;
  user-select: none;
}

.lc-outline__item:hover {
  background: var(--lc-surface-sunken);
}

.lc-outline__item.is-selected {
  background: rgba(37, 99, 235, 0.12);
  color: var(--lc-accent);
}

.lc-outline__item.is-muted .lc-outline__label {
  opacity: 0.45;
}

/* 放置指示线画在当前行上下边缘，避免插入位置含糊 */
.lc-outline__item.is-drop-before {
  border-top-color: var(--lc-accent);
}

.lc-outline__item.is-drop-after {
  border-bottom-color: var(--lc-accent);
}

.lc-outline__chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: none;
  color: currentColor;
  cursor: pointer;
}

.lc-outline__chevron:hover {
  background: var(--lc-surface);
}

.lc-outline__chevron--placeholder {
  cursor: default;
}

.lc-outline__icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: var(--lc-text-secondary);
}

.lc-outline__item.is-selected .lc-outline__icon {
  color: var(--lc-accent-bright);
}

.lc-outline__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-outline__input {
  flex: 1;
  min-width: 0;
  padding: 2px 4px;
  border: 1px solid var(--lc-accent);
  border-radius: 4px;
  background: var(--lc-surface);
  color: var(--lc-text);
  font: inherit;
}

.lc-outline__actions {
  display: flex;
  gap: 2px;
}

.lc-outline__flag {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--lc-text-secondary);
  cursor: pointer;
  opacity: 0;
}

.lc-outline__item:hover .lc-outline__flag,
.lc-outline__flag[aria-pressed='true'] {
  opacity: 1;
}

.lc-outline__flag:hover {
  background: var(--lc-surface);
  color: var(--lc-text);
}

.lc-outline__flag[aria-pressed='true'] {
  color: var(--lc-accent);
}
</style>
