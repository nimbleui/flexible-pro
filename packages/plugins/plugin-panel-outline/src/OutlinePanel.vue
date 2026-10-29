<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Disposable } from '@lc/kernel'
import type { DocumentService, SelectionService } from '@lc/contracts'
import type { NodePosition, NodeSchema, OutlineItem, SchemaPatch } from '@lc/schema'
import { buildOutlineTree, renameNode, reorderChildren, setNodeFlags } from '@lc/schema'
import { useAppContext } from '@lc/vue'

defineProps<{
  /** 宿主传入的只读上下文；面板自己从注入的 Context 取服务 */
  context?: Record<string, unknown>
}>()

const ctx = useAppContext()
const document = ctx.get<DocumentService>('document')
const selection = ctx.get<SelectionService>('selection')

/** 行高与样式里的 .lc-outline__item 高度一致：落点只按上半 / 下半判断，不需要量 DOM */
const ROW_HEIGHT = 28

const version = ref(0)
const disposables: Disposable[] = []

/** 折叠的节点 id；整组替换以触发响应式更新 */
const collapsed = ref<ReadonlySet<string>>(new Set<string>())
const renamingId = ref<string | null>(null)
const renameValue = ref('')

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
  key: string
  node: NodeSchema
  depth: number
  expandable: boolean
  expanded: boolean
  selected: boolean
  /** 在父级数组中的位置；根节点与游离节点没有 */
  position?: NodePosition
}

const rows = computed<LayerRow[]>(() => {
  version.value
  if (!document) return []

  const result: LayerRow[] = []
  const selectedIds = new Set(selection?.ids ?? [])

  const walk = (item: OutlineItem, depth: number): void => {
    const expandable = item.children.length > 0
    const expanded = !collapsed.value.has(item.node.id)
    result.push({
      key: item.node.id,
      node: item.node,
      depth,
      expandable,
      expanded,
      selected: selectedIds.has(item.node.id),
      position: item.position,
    })
    if (!expandable || !expanded) return
    for (const child of item.children) walk(child, depth + 1)
  }

  for (const item of buildOutlineTree(document.model.schema)) walk(item, 0)
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
    <div class="lc-outline__hint">顺序：底层 → 顶层</div>
    <ul class="lc-outline__list">
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
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path
              :d="row.expanded ? 'M2 4l4 4 4-4' : 'M4 2l4 4-4 4'"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <span v-else class="lc-outline__chevron lc-outline__chevron--placeholder" />

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
  </div>
</template>

<style scoped>
.lc-outline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--lc-text);
}

.lc-outline--empty {
  padding: 12px;
  color: var(--lc-text-secondary);
}

.lc-outline__hint {
  padding: 0 4px;
  color: var(--lc-text-secondary);
  font-size: 11px;
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
