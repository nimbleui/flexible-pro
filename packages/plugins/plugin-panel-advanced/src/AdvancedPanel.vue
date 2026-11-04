<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { DocumentService, SelectionService } from '@lc/contracts'
import type { Directive, NodeSchema, SchemaPatch } from '@lc/schema'
import { nodePath } from '@lc/schema'
import { useAppContext } from '@lc/vue'
import {
  DIRECTIVE_TYPES,
  appendDirective,
  removeDirective,
  updateDirective,
} from './utils/directives'
import { fromExpression, toExpression } from './utils/expression-field'

defineProps<{
  /** 宿主传入的只读上下文 */
  context?: Record<string, unknown>
}>()

const ctx = useAppContext()
const document = ctx.get<DocumentService>('document')
const selection = ctx.get<SelectionService>('selection')

const version = ref(0)
/** 挂载期注册的订阅；卸载时逐个释放，面板重挂不会叠加监听 */
const disposables: Array<{
  /** 解绑这一条订阅，重复调用不安全，因此只在 onUnmounted 走一次 */
  dispose(): void
}> = []

const bump = (): void => {
  version.value += 1
}

onMounted(() => {
  if (selection) disposables.push(selection.onDidChange(bump))
  if (document) disposables.push(document.onDidChange(bump))
})

onUnmounted(() => {
  for (const disposable of disposables) disposable.dispose()
  disposables.length = 0
})

const selectionCount = computed(() => {
  version.value
  return selection?.ids.length ?? 0
})

const node = computed<NodeSchema | undefined>(() => {
  version.value
  const id = selection?.primary
  return id ? document?.model.schema.nodes[id] : undefined
})

const directives = computed<readonly Directive[]>(() => node.value?.directives ?? [])

const loopDataSourceText = computed(() => fromExpression(node.value?.loop?.dataSource))

/** 循环数据源草稿：只在「启用循环」那一步消费，启用之后直接读写 schema */
const loopDraft = ref('')

function path(suffix: string): string {
  return node.value ? nodePath(node.value.id, suffix) : ''
}

function commit(patches: readonly SchemaPatch[], label: string): void {
  if (!document || !node.value || patches.length === 0) return
  document.apply(patches, { record: true, label })
}

function onName(event: Event): void {
  const text = (event.target as HTMLInputElement).value.trim()
  if (text === '') {
    if (node.value?.name === undefined) return
    commit([{ op: 'remove', path: path('name') }], '修改节点名称')
    return
  }
  if (text === node.value?.name) return
  commit([{ op: 'replace', path: path('name'), value: text }], '修改节点名称')
}

/** 关闭开关写「删键」而不是 `false`：schema 里只留与默认值不同的意图，导出更干净 */
function onFlag(field: 'hidden' | 'locked', event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  if (checked === Boolean(node.value?.[field])) return

  commit(
    checked
      ? [{ op: 'replace', path: path(field), value: true }]
      : [{ op: 'remove', path: path(field) }],
    field === 'hidden' ? (checked ? '隐藏节点' : '取消隐藏') : '切换锁定',
  )
}

function onCondition(event: Event): void {
  const expression = toExpression((event.target as HTMLInputElement).value)

  if (!expression) {
    if (node.value?.condition === undefined) return
    commit([{ op: 'remove', path: path('condition') }], '清除条件渲染')
    return
  }

  commit([{ op: 'replace', path: path('condition'), value: expression }], '修改条件渲染')
}

/**
 * 启用循环。
 *
 * 数据源是 `LoopConfig` 的唯一必填字段，没有它这条配置就是残缺的，所以只在文本能
 * 折成表达式时才落盘。
 */
function enableLoop(): void {
  const expression = toExpression(loopDraft.value)
  if (!expression) return

  commit([{ op: 'replace', path: path('loop'), value: { dataSource: expression } }], '启用循环')
  loopDraft.value = ''
}

function disableLoop(): void {
  if (node.value?.loop === undefined) return
  commit([{ op: 'remove', path: path('loop') }], '关闭循环')
}

/** 清空数据源等于不再循环：留着一条没有数据源的 loop 会让校验与运行时都难以解释 */
function onLoopDataSource(event: Event): void {
  const expression = toExpression((event.target as HTMLInputElement).value)
  if (!expression) {
    disableLoop()
    return
  }

  commit(
    [{ op: 'replace', path: path('loop/dataSource'), value: expression }],
    '修改循环数据源',
  )
}

function onLoopAlias(field: 'itemName' | 'indexName', event: Event): void {
  const text = (event.target as HTMLInputElement).value.trim()
  const current = node.value?.loop?.[field]

  if (text === '') {
    if (current === undefined) return
    commit([{ op: 'remove', path: path(`loop/${field}`) }], '修改循环变量名')
    return
  }
  if (text === current) return

  commit([{ op: 'replace', path: path(`loop/${field}`), value: text }], '修改循环变量名')
}

/** 指令表整体替换：逐条按下标写路径会在同一批编辑互相覆盖，整表一次写入更稳 */
function commitDirectives(list: readonly Directive[], label: string): void {
  commit(
    list.length === 0
      ? [{ op: 'remove', path: path('directives') }]
      : [{ op: 'replace', path: path('directives'), value: [...list] }],
    label,
  )
}

function addDirective(): void {
  commitDirectives(appendDirective(directives.value), '新增指令')
}

function dropDirective(index: number): void {
  commitDirectives(removeDirective(directives.value, index), '删除指令')
}

function onDirectiveType(index: number, event: Event): void {
  const type = (event.target as HTMLSelectElement).value as Directive['type']
  commitDirectives(updateDirective(directives.value, index, { type }), '修改指令类型')
}

function onDirectiveCondition(index: number, event: Event): void {
  const expression = toExpression((event.target as HTMLInputElement).value)
  if (!expression) return

  commitDirectives(
    updateDirective(directives.value, index, { condition: expression }),
    '修改指令条件',
  )
}
</script>

<template>
  <div class="lc-advanced">
    <div v-if="!node" class="lc-advanced__empty">
      {{
        selectionCount > 1
          ? `已选中 ${selectionCount} 个节点，请单选后编辑高级配置`
          : '选中画布节点查看高级配置'
      }}
    </div>

    <template v-else>
      <div class="lc-advanced__header">
        <span class="lc-advanced__component">{{ node.componentName }}</span>
        <span class="lc-advanced__id">{{ node.id }}</span>
      </div>

      <section class="lc-advanced__section">
        <h4>节点标识</h4>
        <label class="lc-advanced__field">
          <span>图层显示名</span>
          <input
            type="text"
            :value="node.name ?? ''"
            :placeholder="node.componentName"
            @change="onName($event)"
          />
        </label>
        <p class="lc-advanced__hint">留空时大纲与事件面板直接显示组件名。</p>
      </section>

      <section class="lc-advanced__section">
        <h4>设计态开关</h4>
        <label class="lc-advanced__switch">
          <input
            type="checkbox"
            :checked="node.hidden === true"
            @change="onFlag('hidden', $event)"
          />
          <span>隐藏（不渲染、不参与画布命中）</span>
        </label>
        <label class="lc-advanced__switch">
          <input
            type="checkbox"
            :checked="node.locked === true"
            @change="onFlag('locked', $event)"
          />
          <span>锁定（画布上点不到，只能从大纲选）</span>
        </label>
      </section>

      <section class="lc-advanced__section">
        <h4>条件渲染</h4>
        <input
          type="text"
          class="lc-advanced__input"
          :value="fromExpression(node.condition)"
          placeholder="如 {{ data.isVisible }}"
          aria-label="条件渲染表达式"
          @change="onCondition($event)"
        />
        <p class="lc-advanced__hint">
          为假时整棵子树不渲染、实例销毁；与「隐藏」不同，它由运行时表达式决定。
        </p>
      </section>

      <section class="lc-advanced__section">
        <h4>循环渲染</h4>

        <div v-if="!node.loop" class="lc-advanced__loop-enable">
          <input
            v-model="loopDraft"
            type="text"
            class="lc-advanced__input"
            placeholder="数组数据源，如 {{ data.list }}"
            aria-label="循环数据源"
            @keydown.enter="enableLoop"
          />
          <button
            type="button"
            class="lc-advanced__button"
            :disabled="toExpression(loopDraft) === undefined"
            @click="enableLoop"
          >
            启用循环
          </button>
        </div>

        <template v-else>
          <label class="lc-advanced__field">
            <span>数据源</span>
            <input type="text" :value="loopDataSourceText" @change="onLoopDataSource($event)" />
          </label>
          <div class="lc-advanced__grid">
            <label>
              <span>当前项名</span>
              <input
                type="text"
                placeholder="$item"
                :value="node.loop.itemName ?? ''"
                @change="onLoopAlias('itemName', $event)"
              />
            </label>
            <label>
              <span>下标名</span>
              <input
                type="text"
                placeholder="$index"
                :value="node.loop.indexName ?? ''"
                @change="onLoopAlias('indexName', $event)"
              />
            </label>
          </div>
          <button type="button" class="lc-advanced__button" @click="disableLoop">
            关闭循环
          </button>
          <p class="lc-advanced__hint">
            循环项在子节点的属性与条件表达式里按上面的名字引用；清空数据源即关闭循环。
          </p>
        </template>
      </section>

      <section class="lc-advanced__section">
        <h4>指令</h4>

        <div
          v-for="(directive, index) in directives"
          :key="index"
          class="lc-advanced__directive"
        >
          <select
            class="lc-advanced__select"
            :value="directive.type"
            :aria-label="`第 ${index + 1} 条指令的类型`"
            @change="onDirectiveType(index, $event)"
          >
            <option v-for="option in DIRECTIVE_TYPES" :key="option.type" :value="option.type">
              {{ option.label }}
            </option>
          </select>
          <input
            type="text"
            class="lc-advanced__input"
            :value="fromExpression(directive.condition)"
            placeholder="生效条件，如 {{ data.count === 0 }}"
            :aria-label="`第 ${index + 1} 条指令的条件`"
            @change="onDirectiveCondition(index, $event)"
          />
          <button
            type="button"
            class="lc-advanced__remove"
            :aria-label="`删除第 ${index + 1} 条指令`"
            title="删除指令"
            @click="dropDirective(index)"
          >
            ×
          </button>
        </div>

        <button type="button" class="lc-advanced__button" @click="addDirective">
          添加指令
        </button>
        <p class="lc-advanced__hint">
          按顺序求值，同类型后写者生效；条件为空时该指令不生效。只读与必填指令协议里有、
          渲染层尚未实现。
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.lc-advanced {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 12px;
  color: var(--lc-text);
}

.lc-advanced__empty {
  padding: 12px;
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  text-align: center;
}

.lc-advanced__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.lc-advanced__component {
  font-weight: 600;
}

.lc-advanced__id {
  color: var(--lc-text-muted);
  font-family: monospace;
  font-size: 11px;
}

.lc-advanced__section h4 {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--lc-text-secondary);
  letter-spacing: 0.3px;
}

.lc-advanced__field,
.lc-advanced__grid label,
.lc-advanced__loop-enable {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.lc-advanced__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}

.lc-advanced__grid span {
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-advanced__field span {
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-advanced__input,
.lc-advanced__grid input,
.lc-advanced__field input,
.lc-advanced__select {
  width: 100%;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  box-sizing: border-box;
}

.lc-advanced__loop-enable {
  flex-direction: row;
  gap: 6px;
}

.lc-advanced__loop-enable .lc-advanced__input {
  flex: 1;
}

.lc-advanced__section > .lc-advanced__input {
  margin-bottom: 8px;
}

.lc-advanced__switch {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: var(--lc-text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.lc-advanced__switch input {
  flex: none;
  width: 14px;
  height: 14px;
}

.lc-advanced__button {
  align-self: flex-start;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--lc-border-strong);
  border-radius: 6px;
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.lc-advanced__button:hover:not(:disabled) {
  border-color: var(--lc-accent);
}

.lc-advanced__button:disabled {
  border-color: var(--lc-border);
  background: transparent;
  color: var(--lc-text-muted);
  cursor: not-allowed;
}

.lc-advanced__directive {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.lc-advanced__remove {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--lc-text-muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.lc-advanced__remove:hover {
  border-color: var(--lc-danger-border);
  color: var(--lc-danger);
}

.lc-advanced__hint {
  margin: 6px 0 0;
  color: var(--lc-text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.lc-advanced__button:focus-visible,
.lc-advanced__remove:focus-visible,
.lc-advanced__input:focus-visible,
.lc-advanced__select:focus-visible,
.lc-advanced__grid input:focus-visible,
.lc-advanced__field input:focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}
</style>
