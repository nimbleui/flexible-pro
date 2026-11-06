<script setup lang="ts">
import { ref } from 'vue'
import type { EventConnection } from '@lc/schema'
import { BUILTIN_ACTIONS } from '@lc/schema'
import type { NodeEventRow } from './composables/use-node-event-bindings'
import { useNodeEventBindings } from './composables/use-node-event-bindings'

defineProps<{
  /** 宿主传入的只读上下文 */
  context?: Record<string, unknown>
}>()

const {
  node,
  selectionCount,
  rows,
  issues,
  flowOptionsOf,
  bind,
  unbind,
  setEnabled,
  setFlow,
  addAction,
  removeAction,
} = useNodeEventBindings()

/** 自定义事件名草稿：物料没声明事件的组件（如基础矩形）也要能绑 */
const customName = ref('')

function bindCustom(): void {
  bind(customName.value)
  customName.value = ''
}

function onBindChange(connection: EventConnection, event: Event): void {
  const target = event.target
  if (target instanceof HTMLInputElement) setEnabled(connection, target.checked)
}

/** 选择流程图；空串表示解绑，未绑定的事件选中某张图时会顺带建立连接 */
function onFlowChange(row: NodeEventRow, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return

  setFlow(row, target.value)
}

function onAddAction(connection: EventConnection, event: Event): void {
  const select = event.target as HTMLSelectElement
  const type = select.value
  if (!type) return

  addAction(connection, type)
  // 复位到占位项，否则第二次点击「添加动作」时 select 值没变、change 不再触发
  select.value = ''
}
</script>

<template>
  <div class="lc-node-event">
    <div v-if="!node" class="lc-node-event__empty">
      {{
        selectionCount > 1
          ? `已选中 ${selectionCount} 个节点，请单选后编辑事件`
          : '选中画布节点查看事件'
      }}
    </div>

    <template v-else>
      <div class="lc-node-event__header">
        <span class="lc-node-event__name">{{ node.name || node.componentName }}</span>
        <span class="lc-node-event__id">{{ node.id }}</span>
      </div>

      <p class="lc-node-event__hint">
        这里只管「事件接没接上动作链」。动作的参数、顺序与分支在底部「事件流」面板里配置。
      </p>

      <ul v-if="issues.length > 0" class="lc-node-event__issues">
        <li
          v-for="issue in issues"
          :key="`${issue.path}:${issue.message}`"
          :data-severity="issue.severity"
        >
          {{ issue.message }}
        </li>
      </ul>

      <section v-for="row in rows" :key="row.eventName" class="lc-node-event__row">
        <header class="lc-node-event__row-head">
          <span class="lc-node-event__title">{{ row.definition?.title ?? row.eventName }}</span>
          <span
            class="lc-node-event__badge"
            :class="
              row.connection ? 'lc-node-event__badge--bound' : 'lc-node-event__badge--free'
            "
          >
            {{ row.connection ? '已绑定' : '未绑定' }}
          </span>
        </header>

        <code class="lc-node-event__event-name">{{ row.eventName }}</code>
        <p v-if="row.definition?.parameters?.length" class="lc-node-event__params">
          参数：
          <span v-for="item in row.definition.parameters" :key="item.name">
            event.{{ item.name }}
          </span>
        </p>

        <button
          v-if="!row.connection"
          type="button"
          class="lc-node-event__button"
          @click="bind(row.eventName)"
        >
          绑定事件
        </button>

        <template v-else>
          <div class="lc-node-event__chain">
            <ol v-if="row.steps.length > 0" class="lc-node-event__steps">
              <li v-for="(step, index) in row.steps" :key="step.id">
                <span class="lc-node-event__step-title">{{ index + 1 }}. {{ step.title }}</span>
                <span v-if="step.summary" class="lc-node-event__step-summary">{{
                  step.summary
                }}</span>
                <button
                  type="button"
                  class="lc-node-event__remove"
                  :aria-label="`从链中移除 ${step.title}`"
                  title="从链中移除"
                  @click="removeAction(row.connection!, step.id)"
                >
                  ×
                </button>
              </li>
            </ol>
            <p v-else class="lc-node-event__empty-chain">链上还没有动作。</p>

            <div class="lc-node-event__tools">
              <select
                class="lc-node-event__select"
                :aria-label="`为 ${row.eventName} 添加动作`"
                @change="onAddAction(row.connection!, $event)"
              >
                <option value="">添加动作…</option>
                <option
                  v-for="action in BUILTIN_ACTIONS"
                  :key="action.type"
                  :value="action.type"
                >
                  {{ action.title }}
                </option>
              </select>

              <label class="lc-node-event__switch">
                <input
                  type="checkbox"
                  :checked="row.connection.enabled"
                  @change="onBindChange(row.connection!, $event)"
                />
                <span>启用</span>
              </label>

              <button
                type="button"
                class="lc-node-event__button lc-node-event__button--danger"
                @click="unbind(row.connection!)"
              >
                解绑
              </button>
            </div>
          </div>
        </template>

        <!--
          事件跑哪张流程图。这一行**不依赖事件是否已绑定动作链**：连接是这个事件的执行记录，
          只挂图、链上留空同样合法；把它藏在「绑定事件」之后，用户看到的就是「这里没有绑流程的地方」。
          链与图是同一事件上的两条执行体，先链后图、互不覆盖；这里只写 id，图的内容归流程编辑器。
        -->
        <div class="lc-node-event__flow">
          <label class="lc-node-event__flow-label" :for="`lc-node-event-flow-${row.eventName}`"
            >执行流程图</label
          >
          <select
            :id="`lc-node-event-flow-${row.eventName}`"
            class="lc-node-event__select"
            :value="row.connection?.flowId ?? ''"
            @change="onFlowChange(row, $event)"
          >
            <option value="">不绑定</option>
            <option
              v-for="option in flowOptionsOf(row)"
              :key="option.value"
              :value="option.value"
              :title="option.description"
            >
              {{ option.label }}{{ option.effective ? '' : ' · 暂不生效' }}
            </option>
          </select>
        </div>
        <p v-if="row.flowSummary && !row.flowEffective" class="lc-node-event__flow-note">
          {{ row.flowSummary }}：这条事件暂时只会执行动作链
        </p>
      </section>

      <section class="lc-node-event__custom">
        <h4>自定义事件</h4>
        <div class="lc-node-event__custom-row">
          <input
            v-model="customName"
            type="text"
            class="lc-node-event__input"
            placeholder="事件名，如 change"
            aria-label="自定义事件名"
            @keydown.enter="bindCustom"
          />
          <button type="button" class="lc-node-event__button" @click="bindCustom">绑定</button>
        </div>
        <p class="lc-node-event__hint">
          物料没声明事件时用这里手填；名字必须与组件 emit 的事件名一致，否则运行时不会触发。
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.lc-node-event {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 12px;
  color: var(--lc-text);
}

.lc-node-event__empty {
  padding: 12px;
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  text-align: center;
}

.lc-node-event__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.lc-node-event__name {
  font-weight: 600;
  font-size: 12px;
}

.lc-node-event__event-name {
  align-self: flex-start;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(127, 155, 194, 0.12);
  color: var(--lc-text-secondary);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 10px;
}

.lc-node-event__id {
  color: var(--lc-text-muted);
  font-family: monospace;
  font-size: 11px;
}

.lc-node-event__hint {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.lc-node-event__issues {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 11px;
  line-height: 1.5;
  list-style: none;
}

.lc-node-event__issues li[data-severity='warning'] {
  color: var(--lc-warning);
}

.lc-node-event__row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
}

.lc-node-event__row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.lc-node-event__title {
  font-weight: 600;
}

.lc-node-event__badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
}

.lc-node-event__badge--bound {
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-node-event__badge--free {
  background: rgba(127, 155, 194, 0.14);
  color: var(--lc-text-secondary);
}

.lc-node-event__params {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 10px;
}

.lc-node-event__params span {
  font-family: monospace;
}

.lc-node-event__chain {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px dashed var(--lc-border);
}

.lc-node-event__steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-node-event__steps li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 4px 6px;
}

.lc-node-event__step-title {
  min-width: 0;
  overflow-wrap: anywhere;
}

.lc-node-event__step-summary {
  grid-column: 1 / -1;
  color: var(--lc-text-muted);
  font-size: 10px;
  overflow-wrap: anywhere;
}

.lc-node-event__empty-chain {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-node-event__remove {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--lc-text-muted);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.lc-node-event__remove:hover {
  border-color: var(--lc-danger-border);
  color: var(--lc-danger);
}

.lc-node-event__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.lc-node-event__select,
.lc-node-event__input {
  height: 26px;
  min-width: 0;
  padding: 0 6px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
  box-sizing: border-box;
}

.lc-node-event__select {
  flex: 1;
}

/* 绑定流程图一行：与动作链并列的第二条执行体，所以放在链的摘要之后而不是混进工具条 */
.lc-node-event__flow {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--lc-border-subtle);
}

.lc-node-event__flow-label {
  flex: none;
  color: var(--lc-text-muted);
  font-size: 11px;
}

/* 只在绑定不生效时出现：绑了草稿或图被删了，用户需要知道这条事件其实跑不到图 */
.lc-node-event__flow-note {
  margin: 4px 0 0;
  color: var(--lc-warning, #f5a524);
  font-size: 11px;
}

.lc-node-event__switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--lc-text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.lc-node-event__button {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--lc-border-strong);
  border-radius: 6px;
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.lc-node-event__button:hover {
  border-color: var(--lc-accent);
}

.lc-node-event__button--danger {
  background: var(--lc-danger-surface);
  border-color: var(--lc-danger-border);
  color: var(--lc-danger);
}

.lc-node-event__custom {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lc-node-event__custom h4 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--lc-text-secondary);
  letter-spacing: 0.3px;
}

.lc-node-event__custom-row {
  display: flex;
  gap: 6px;
}

.lc-node-event__custom-row .lc-node-event__input {
  flex: 1;
}

.lc-node-event__remove:focus-visible,
.lc-node-event__button:focus-visible,
.lc-node-event__select:focus-visible,
.lc-node-event__input:focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}
</style>
