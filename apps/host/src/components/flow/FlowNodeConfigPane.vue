<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import type { ActionErrorStrategy, ActionFieldSchema, FlowNode, RefOption } from '@lc/schema'
import {
  FLOW_SUBFLOW,
  FLOW_TRIGGER,
  findFlowNodeType,
  flowNodeFields,
  isExpressionString,
  listRefOptions,
} from '@lc/schema'
import type { FlowService } from '@lc/contracts'
import { useAppContext } from '@lc/vue'
import type { FlowEditorHandle } from './composables/use-flow-editor'
import { pages } from '../../pages/page-store'
import { resolveProjectId } from '../../projects/project-model'
import type { FlowUsage } from './utils/flow-usage'
import { findFlowUsages } from './utils/flow-usage'
import { flowNodeTone } from './constants/node-tone'
import FlowFieldControl from './FlowFieldControl.vue'
import {
  fieldDraftText,
  isTextOrEmpty,
  parseFieldDraft,
  parseObjectDraft,
  useFlowFieldDraft,
} from './composables/use-flow-field-draft'

const props = defineProps<{
  /** 流程编辑器句柄；面板只读它的选中项，写入一律走它提供的方法 */
  editor: FlowEditorHandle
}>()

type NodeSubTab = 'basic' | 'advanced' | 'error'

/** 异常处置的三种策略；文案与 `ActionDeclaration.onError` 的注释一致 */
const ERROR_STRATEGIES: readonly { value: ActionErrorStrategy; label: string }[] = [
  { value: 'stop', label: '中断流程' },
  { value: 'continue', label: '忽略继续' },
  { value: 'fallback', label: '转补救节点' },
]

const subTab = ref<NodeSubTab>('basic')
const isHeaderCollapsed = ref(false)
const isMappingOpen = ref(true)

const node = computed(() => props.editor.selectedNode.value)

const nodeTitle = computed(() => {
  const value = node.value
  if (!value) return ''

  return value.name ?? findFlowNodeType(value.type)?.title ?? value.type
})

const nodeSubtitle = computed(() => {
  const value = node.value
  if (!value) return ''

  return value.description ?? findFlowNodeType(value.type)?.description ?? ''
})

/**
 * 头部图标方块的配色。
 *
 * 色调由 `flowNodeTone` 给出的是**变量名**，这里展开成 `var(--lc-xxx)` 再交给内联样式：
 * 色值始终只在 tokens.css 里定义，面板不复制一份。
 */
const iconStyle = computed<CSSProperties>(() => {
  const value = node.value
  if (!value) return {}

  const tone = `var(${flowNodeTone(value)})`

  return {
    color: tone,
    borderColor: `color-mix(in srgb, ${tone} 40%, transparent)`,
    background: `color-mix(in srgb, ${tone} 16%, transparent)`,
  }
})

const fields = computed<readonly ActionFieldSchema[]>(() =>
  node.value ? flowNodeFields(node.value.type) : [],
)

/**
 * 引用型字段的候选。
 *
 * 图上的引用只剩一种：`flow.subflow` 指向的另一个流程。项目归属取图自己的 `projectId`
 * 而不是路由参数——图上的字段才是「这张图属于谁」的事实来源，候选跟着同一个值走，
 * 才不会出现在 A 项目的图里选到 B 项目的流程。编辑器随路由重建，所以这里一次性取值即可。
 */
const appCtx = useAppContext()

const subflowOptions = computed(() =>
  listRefOptions('flow', {
    flows: appCtx.get<FlowService>('flow')?.list(),
    exclude: node.value?.type === FLOW_SUBFLOW ? node.value?.id : undefined,
  }),
)

/**
 * 按字段声明取候选。
 *
 * 曾经这里还要给触发节点准备「所在页面 / 来源节点 / 事件名」三段候选，跨文档去读别人的
 * 页面表与物料声明。绑定改成页面持有之后，图侧不再引用任何页面，这三段候选随之消失；
 * `variable` / `dataSource` / `action` 在图里没有对应的命名空间可列，返回空列表由面板提示。
 */
function refOptionsFor(field: ActionFieldSchema): readonly RefOption[] {
  return field.ref === 'flow' ? subflowOptions.value : []
}

/** 触发节点才有「谁在用我」可查；其它节点这一栏只会是空的 */
const isTriggerNode = computed(() => node.value?.type === FLOW_TRIGGER)

/**
 * 「本图被哪些页面事件引用」的结果；`null` 表示还没扫过。
 *
 * 懒加载是有意的：绑定写在各个页面文档里，要回答这个问题只能把项目里所有页面读一遍。
 * 选中一个节点就重扫整批文档既慢又没人看，做成点一下才发生。
 */
const usages = ref<readonly FlowUsage[] | null>(null)

/** 换节点就丢掉上一次的结果，否则会把上一张图的引用显示在当前图的面板上 */
watch(
  () => node.value?.id,
  () => {
    usages.value = null
  },
)

function scanUsages(): void {
  const flow = props.editor.flow.value
  if (!flow) return

  const projectId = resolveProjectId(flow.projectId)
  usages.value = findFlowUsages(
    pages.value
      .filter((page) => resolveProjectId(page.projectId) === projectId)
      .map((page) => ({ id: page.id, title: page.title, schema: page.schema })),
    flow.id,
  )
}

/** 补救节点候选：排除自身，指向自己的补救在执行器里就是原地打转 */
const fallbackOptions = computed(() => {
  const flow = props.editor.flow.value
  const self = node.value?.id
  if (!flow) return []

  return Object.values(flow.nodes)
    .filter((item: FlowNode) => item.id !== self)
    .map((item: FlowNode) => ({
      value: item.id,
      label: item.name ?? findFlowNodeType(item.type)?.title ?? item.id,
    }))
})

const {
  draft: inputMappingText,
  error: inputMappingError,
  onInput: onInputMappingInput,
  commitDraft: commitInputMapping,
} = useFlowFieldDraft({
  display: () => fieldDraftText('json', node.value?.inputMapping),
  parse: parseObjectDraft,
  commit: (value) => {
    const id = node.value?.id
    if (!id || !isMappingValue(value)) return
    props.editor.updateNode(id, { inputMapping: value })
  },
})

const {
  draft: outputMappingText,
  error: outputMappingError,
  onInput: onOutputMappingInput,
  commitDraft: commitOutputMapping,
} = useFlowFieldDraft({
  display: () => fieldDraftText('json', node.value?.outputMapping),
  parse: parseObjectDraft,
  commit: (value) => {
    const id = node.value?.id
    if (!id || !isMappingValue(value)) return
    props.editor.updateNode(id, { outputMapping: value })
  },
})

const {
  draft: nameText,
  onInput: onNameInput,
  commitDraft: commitName,
} = useFlowFieldDraft({
  display: () => fieldDraftText('text', node.value?.name),
  parse: (text) => parseFieldDraft('text', text),
  commit: (value) => {
    const id = node.value?.id
    if (!id || !isTextOrEmpty(value)) return
    props.editor.updateNode(id, { name: value })
  },
})

const {
  draft: descriptionText,
  onInput: onDescriptionInput,
  commitDraft: commitDescription,
} = useFlowFieldDraft({
  display: () => fieldDraftText('text', node.value?.description),
  parse: (text) => parseFieldDraft('text', text),
  commit: (value) => {
    const id = node.value?.id
    if (!id || !isTextOrEmpty(value)) return
    props.editor.updateNode(id, { description: value })
  },
})

/**
 * 执行条件（表达式）。
 *
 * `FlowNode.condition` 的类型是 `ExpressionString`，裸文本会被 `checkExpressionFields`
 * 判成 error，所以这里只可能提交表达式对象或 `undefined`。
 */
const {
  draft: conditionText,
  onInput: onConditionInput,
  commitDraft: commitCondition,
} = useFlowFieldDraft({
  display: () => {
    const condition = node.value?.condition

    return isExpressionString(condition) ? condition.raw : ''
  },
  parse: (text) => parseFieldDraft('expression', text),
  commit: (value) => {
    const id = node.value?.id
    if (!id) return

    if (value === undefined) {
      props.editor.updateNode(id, { condition: undefined })

      return
    }
    if (isExpressionString(value)) props.editor.updateNode(id, { condition: value })
  },
})

/** 映射只接受对象或清空；数组与字面量已由 `parseObjectDraft` 拦下 */
function isMappingValue(value: unknown): value is Record<string, unknown> | undefined {
  if (value === undefined) return true

  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onStrategyChange(event: Event): void {
  const target = event.target
  const id = node.value?.id
  if (!id || !(target instanceof HTMLInputElement) || !target.checked) return

  const strategy = ERROR_STRATEGIES.find((item) => item.value === target.value)
  if (!strategy) return
  props.editor.updateNode(id, { onError: strategy.value })
}

function onFallbackChange(event: Event): void {
  const target = event.target
  const id = node.value?.id
  if (!id || !(target instanceof HTMLSelectElement)) return

  // 空值是合法选择：补救策略下没有目标会被校验判成 error，切回其它策略时应当能清掉
  props.editor.updateNode(id, { fallbackActionId: target.value || undefined })
}

function onFieldCommit(key: string, value: unknown): void {
  const id = node.value?.id
  if (!id) return
  props.editor.updateNodeConfig(id, key, value)
}
</script>

<template>
  <p v-if="!node" class="lc-flow-inspector__empty">请在画布选择一个节点</p>

  <div v-else class="lc-flow-inspector__pane">
    <div class="lc-flow-inspector__node-head">
      <span class="lc-flow-inspector__node-icon" :style="iconStyle">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect
            x="2"
            y="2"
            width="12"
            height="12"
            rx="3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
          />
          <path
            d="M8 5.2v5.6M5.2 8h5.6"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <div class="lc-flow-inspector__node-meta">
        <p class="lc-flow-inspector__node-title">{{ nodeTitle }}</p>
        <p v-if="nodeSubtitle" class="lc-flow-inspector__node-desc">{{ nodeSubtitle }}</p>
      </div>
      <button
        type="button"
        class="lc-flow-inspector__collapse"
        :aria-expanded="!isHeaderCollapsed"
        :aria-label="isHeaderCollapsed ? '展开节点配置' : '收起节点配置'"
        @click="isHeaderCollapsed = !isHeaderCollapsed"
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          :class="{ 'is-collapsed': isHeaderCollapsed }"
        >
          <path
            d="M4 10.5 8 6.5l4 4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <template v-if="!isHeaderCollapsed">
      <div class="lc-flow-inspector__subtabs" role="tablist" aria-label="节点配置分栏">
        <button
          type="button"
          class="lc-flow-inspector__subtab"
          :class="{ 'is-active': subTab === 'basic' }"
          role="tab"
          :aria-selected="subTab === 'basic'"
          @click="subTab = 'basic'"
        >
          基础配置
        </button>
        <button
          type="button"
          class="lc-flow-inspector__subtab"
          :class="{ 'is-active': subTab === 'advanced' }"
          role="tab"
          :aria-selected="subTab === 'advanced'"
          @click="subTab = 'advanced'"
        >
          高级配置
        </button>
        <button
          type="button"
          class="lc-flow-inspector__subtab"
          :class="{ 'is-active': subTab === 'error' }"
          role="tab"
          :aria-selected="subTab === 'error'"
          @click="subTab = 'error'"
        >
          异常处理
        </button>
      </div>

      <div v-if="subTab === 'basic'" class="lc-flow-inspector__form">
        <FlowFieldControl
          v-for="field in fields"
          :key="`${node.id}:${field.key}`"
          :field="field"
          :model-value="node.config[field.key]"
          :node-id="node.id"
          :ref-options="refOptionsFor(field)"
          @commit="onFieldCommit(field.key, $event)"
        />

        <p v-if="fields.length === 0" class="lc-flow-inspector__hint">
          该节点没有需要配置的参数
        </p>

        <!--
          触发节点不再填「绑哪个页面哪个按钮」——绑定由页面持有，入口在设计器右栏的「事件」页签。
          这里只提供反查：作者改图之前最想知道的就是「动了它会不会影响别的页面」。
        -->
        <section v-if="isTriggerNode" class="lc-flow-inspector__section">
          <button type="button" class="lc-flow-inspector__section-head" @click="scanUsages()">
            <span>谁在用这张图</span>
          </button>

          <template v-if="usages">
            <p v-if="usages.length === 0" class="lc-flow-inspector__hint">
              还没有页面事件绑定这张图。在页面设计器里选中节点 → 右栏「事件」→
              「执行流程图」即可绑定。
            </p>
            <ul v-else class="lc-flow-inspector__usage-list">
              <li
                v-for="usage in usages"
                :key="`${usage.documentId}:${usage.sourceNodeId}:${usage.eventName}`"
              >
                <span class="lc-flow-inspector__usage-page">{{ usage.documentTitle }}</span>
                <span class="lc-flow-inspector__usage-node">{{ usage.nodeLabel }}</span>
                <code class="lc-flow-inspector__usage-event">{{ usage.eventName }}</code>
                <span v-if="!usage.effective" class="lc-flow-inspector__usage-off">已停用</span>
              </li>
            </ul>
          </template>
        </section>

        <section class="lc-flow-inspector__section">
          <button
            type="button"
            class="lc-flow-inspector__section-head"
            :aria-expanded="isMappingOpen"
            @click="isMappingOpen = !isMappingOpen"
          >
            <span>输入输出映射</span>
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              :class="{ 'is-collapsed': !isMappingOpen }"
            >
              <path
                d="M4 10.5 8 6.5l4 4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>

          <div v-show="isMappingOpen" class="lc-flow-inspector__section-body">
            <div class="lc-flow-inspector__field">
              <label class="lc-flow-inspector__field-label" for="lc-flow-input-mapping">
                输入数据映射
              </label>
              <textarea
                id="lc-flow-input-mapping"
                class="lc-flow-inspector__textarea"
                :value="inputMappingText"
                placeholder='{"orderId": "{{ data.orderId }}"}'
                rows="5"
                spellcheck="false"
                @input="onInputMappingInput"
                @change="commitInputMapping"
                @blur="commitInputMapping"
              ></textarea>
              <p v-if="inputMappingError" class="lc-flow-inspector__field-error">
                {{ inputMappingError }}
              </p>
            </div>

            <div class="lc-flow-inspector__field">
              <label class="lc-flow-inspector__field-label" for="lc-flow-output-mapping">
                输出数据映射
              </label>
              <textarea
                id="lc-flow-output-mapping"
                class="lc-flow-inspector__textarea"
                :value="outputMappingText"
                placeholder='{"result": "{{ result }}"}'
                rows="5"
                spellcheck="false"
                @input="onOutputMappingInput"
                @change="commitOutputMapping"
                @blur="commitOutputMapping"
              ></textarea>
              <p v-if="outputMappingError" class="lc-flow-inspector__field-error">
                {{ outputMappingError }}
              </p>
            </div>
          </div>
        </section>
      </div>

      <div v-else-if="subTab === 'advanced'" class="lc-flow-inspector__form">
        <div class="lc-flow-inspector__field">
          <label class="lc-flow-inspector__field-label" for="lc-flow-node-name">节点名称</label>
          <input
            id="lc-flow-node-name"
            class="lc-flow-inspector__input"
            type="text"
            :value="nameText"
            placeholder="缺省取节点库标题"
            @input="onNameInput"
            @change="commitName"
            @blur="commitName"
          />
        </div>

        <div class="lc-flow-inspector__field">
          <label class="lc-flow-inspector__field-label" for="lc-flow-node-desc">节点说明</label>
          <input
            id="lc-flow-node-desc"
            class="lc-flow-inspector__input"
            type="text"
            :value="descriptionText"
            placeholder="一句话说明这个节点做什么"
            @input="onDescriptionInput"
            @change="commitDescription"
            @blur="commitDescription"
          />
        </div>

        <div class="lc-flow-inspector__field">
          <label class="lc-flow-inspector__field-label" for="lc-flow-node-condition"
            >执行条件</label
          >
          <input
            id="lc-flow-node-condition"
            class="lc-flow-inspector__input"
            type="text"
            :value="conditionText"
            placeholder="{{ user.role === 'admin' }}"
            @input="onConditionInput"
            @change="commitCondition"
            @blur="commitCondition"
          />
          <small class="lc-flow-inspector__field-note">
            条件为假时跳过本节点并继续后继，留空表示无条件执行
          </small>
        </div>
      </div>

      <div v-else class="lc-flow-inspector__form">
        <div class="lc-flow-inspector__field">
          <span class="lc-flow-inspector__field-label">失败处理</span>
          <div class="lc-flow-inspector__radio-group">
            <label
              v-for="strategy in ERROR_STRATEGIES"
              :key="strategy.value"
              class="lc-flow-inspector__radio"
            >
              <input
                type="radio"
                name="lc-flow-on-error"
                :value="strategy.value"
                :checked="(node.onError ?? 'stop') === strategy.value"
                @change="onStrategyChange"
              />
              <span>{{ strategy.label }}</span>
            </label>
          </div>
        </div>

        <div v-if="node.onError === 'fallback'" class="lc-flow-inspector__field">
          <label class="lc-flow-inspector__field-label" for="lc-flow-node-fallback">
            补救节点
            <em class="lc-flow-inspector__required">*</em>
          </label>
          <select
            id="lc-flow-node-fallback"
            class="lc-flow-inspector__select"
            :value="node.fallbackActionId ?? ''"
            @change="onFallbackChange"
          >
            <option value="">未选择</option>
            <option v-for="option in fallbackOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <small class="lc-flow-inspector__field-note">
            字段名沿用动作协议的 fallbackActionId，图里指向的是补救节点
          </small>
        </div>
      </div>
    </template>
  </div>
</template>
