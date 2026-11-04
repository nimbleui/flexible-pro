<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { PropType } from '@lc/schema'
import type {
  CustomComponentDraft,
  DraftIssueField,
} from '../../custom-components/component-draft'
import {
  SELECTABLE_PROP_TYPES,
  createEventDraft,
  createPropDraft,
  createSlotDraft,
  validateComponentDraft,
} from '../../custom-components/component-draft'
import type { FilterSelectOption } from '../common/filter-select'
import FilterSelect from '../common/FilterSelect.vue'

/**
 * 组件定义表。
 *
 * 管四件事：元信息、对外属性、对外事件、插槽声明。节点图交给画布，因此这里不出现
 * 任何父子层级或坐标——同一份蓝图不该有两个编辑入口。
 */

const props = defineProps<{
  /** 初始草稿；组件按挂载时的值拷贝一份，切换条目请用 key 重建 */
  initial: CustomComponentDraft
  /** 已被占用的组件名（不含正在编辑的这条） */
  takenNames: readonly string[]
}>()

const emit = defineEmits<{
  /**
   * 草稿被改动。
   *
   * 直接带上快照：外壳要用默认值给画布注入 `props` 作用域，让蓝图里的
   * `{{ props.x }}` 在设计态就显示真实取值，而不是等一次显式取数。
   */
  (event: 'change', value: CustomComponentDraft): void
}>()

const PROP_TYPE_LABELS: Readonly<Record<PropType, string>> = {
  string: '文本',
  number: '数字',
  boolean: '布尔',
  color: '颜色',
  enum: '枚举',
  object: '对象',
  array: '数组',
  json: 'JSON',
  icon: '图标',
  style: '样式',
  event: '事件',
  slot: '插槽',
  function: '函数',
}

const propTypeOptions: readonly FilterSelectOption[] = SELECTABLE_PROP_TYPES.map((type) => ({
  value: type,
  label: PROP_TYPE_LABELS[type],
}))

/** 必须来自脚本：模板里直接写 `{{ ... }}` 字面量会被插值语法截断 */
const PROP_SCOPE_EXAMPLE = '{{ props.属性名 }}'

const draft = reactive<CustomComponentDraft>({
  ...props.initial,
  props: props.initial.props.map((item) => ({ ...item })),
  events: props.initial.events.map((item) => ({ ...item })),
  slots: props.initial.slots.map((item) => ({ ...item })),
})

/** 提交前只标必要字段：一进门就满屏飘红等于把校验当装饰 */
const revealed = ref(false)

const issues = computed(() => validateComponentDraft(draft, props.takenNames))

const issuesBySection = computed(() => {
  const grouped = new Map<DraftIssueField, string[]>()
  if (!revealed.value) return grouped

  for (const issue of issues.value) {
    const list = grouped.get(issue.field) ?? []
    list.push(issue.message)
    grouped.set(issue.field, list)
  }
  return grouped
})

function sectionError(field: DraftIssueField): string[] {
  return issuesBySection.value.get(field) ?? []
}

/** 深一层拷贝行对象：行会被逐字段编辑，快照必须与草稿脱钩 */
function snapshotOf(source: CustomComponentDraft): CustomComponentDraft {
  return {
    ...source,
    props: source.props.map((item) => ({ ...item })),
    events: source.events.map((item) => ({ ...item })),
    slots: source.slots.map((item) => ({ ...item })),
  }
}

watch(draft, () => emit('change', snapshotOf(draft)), { deep: true })

function toPropType(value: string): PropType {
  return SELECTABLE_PROP_TYPES.find((type) => type === value) ?? 'string'
}

function addProp(): void {
  draft.props.push(createPropDraft())
}

function removeProp(index: number): void {
  draft.props.splice(index, 1)
}

function addEvent(): void {
  draft.events.push(createEventDraft())
}

function removeEvent(index: number): void {
  draft.events.splice(index, 1)
}

function addSlot(): void {
  draft.slots.push(createSlotDraft())
}

function removeSlot(index: number): void {
  draft.slots.splice(index, 1)
}

defineExpose({
  /**
   * 校验并展示错误。
   *
   * @returns 全部错误；空数组表示可以保存
   */
  validate(): typeof issues.value {
    revealed.value = true
    return issues.value
  },
  /** 当前草稿快照；外壳据此合成组件定义 */
  snapshot(): CustomComponentDraft {
    return snapshotOf(draft)
  },
})
</script>

<template>
  <div class="lc-component-def">
    <section class="lc-component-def__section">
      <h3 class="lc-component-def__title">基本信息</h3>
      <p v-if="sectionError('name').length" class="lc-component-def__error" role="alert">
        {{ sectionError('name').join('；') }}
      </p>

      <label class="lc-component-def__field">
        <span class="lc-component-def__label">组件名<em aria-hidden="true">*</em></span>
        <input
          v-model="draft.name"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="ScoreCard"
        />
      </label>
      <label class="lc-component-def__field">
        <span class="lc-component-def__label">展示标题<em aria-hidden="true">*</em></span>
        <input v-model="draft.title" type="text" autocomplete="off" placeholder="评分卡" />
      </label>
      <label class="lc-component-def__field">
        <span class="lc-component-def__label">分组<em aria-hidden="true">*</em></span>
        <input v-model="draft.group" type="text" autocomplete="off" placeholder="自定义" />
      </label>
      <label class="lc-component-def__field">
        <span class="lc-component-def__label">版本号<em aria-hidden="true">*</em></span>
        <input v-model="draft.version" type="text" autocomplete="off" spellcheck="false" />
      </label>
      <label class="lc-component-def__field">
        <span class="lc-component-def__label">图标名</span>
        <input v-model="draft.icon" type="text" autocomplete="off" spellcheck="false" />
      </label>
      <label class="lc-component-def__field">
        <span class="lc-component-def__label">说明</span>
        <input v-model="draft.description" type="text" autocomplete="off" />
      </label>
    </section>

    <section class="lc-component-def__section">
      <h3 class="lc-component-def__title">
        对外属性
        <span class="lc-component-def__count">{{ draft.props.length }}</span>
      </h3>
      <p class="lc-component-def__hint">
        属性在画布属性面板里编辑；蓝图里用
        <code>{{ PROP_SCOPE_EXAMPLE }}</code> 引用，默认值同时是设计态取值。
      </p>
      <p v-if="sectionError('props').length" class="lc-component-def__error" role="alert">
        {{ sectionError('props').join('；') }}
      </p>

      <div v-for="(row, index) in draft.props" :key="index" class="lc-component-def__prop">
        <div class="lc-component-def__prop-line">
          <input
            v-model="row.name"
            class="lc-component-def__mono"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="属性名"
            aria-label="属性名"
          />
          <input
            v-model="row.title"
            type="text"
            autocomplete="off"
            placeholder="显示标题"
            aria-label="属性标题"
          />
          <button
            type="button"
            class="lc-component-def__row-button lc-component-def__row-button--danger"
            aria-label="删除属性"
            @click="removeProp(index)"
          >
            删除
          </button>
        </div>

        <div class="lc-component-def__prop-line">
          <FilterSelect
            :model-value="row.type"
            :options="propTypeOptions"
            aria-label="属性类型"
            @update:model-value="row.type = toPropType($event)"
          />
          <input
            v-model="row.defaultText"
            type="text"
            autocomplete="off"
            placeholder="默认值"
            aria-label="属性默认值"
          />
        </div>

        <textarea
          v-if="row.type === 'enum'"
          v-model="row.optionsText"
          class="lc-component-def__options"
          rows="2"
          spellcheck="false"
          placeholder="每行一个选项：值 或 值=标签"
          aria-label="枚举选项"
        />
      </div>

      <p v-if="draft.props.length === 0" class="lc-component-def__empty">
        还没有对外属性，画布上只能调整它的位置与大小。
      </p>

      <button type="button" class="lc-component-def__add" @click="addProp">+ 添加属性</button>
    </section>

    <section class="lc-component-def__section">
      <h3 class="lc-component-def__title">
        对外事件
        <span class="lc-component-def__count">{{ draft.events.length }}</span>
      </h3>
      <p class="lc-component-def__hint">
        事件名供页面「事件流」接线；运行时预览按这里的参数名折叠实参，复合组件自身不会 emit。
      </p>
      <p v-if="sectionError('events').length" class="lc-component-def__error" role="alert">
        {{ sectionError('events').join('；') }}
      </p>

      <div v-for="(row, index) in draft.events" :key="index" class="lc-component-def__event">
        <div class="lc-component-def__event-line">
          <input
            v-model="row.name"
            class="lc-component-def__mono"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="事件名，如 click"
            aria-label="事件名"
          />
          <input
            v-model="row.title"
            type="text"
            autocomplete="off"
            placeholder="显示标题"
            aria-label="事件标题"
          />
          <button
            type="button"
            class="lc-component-def__row-button lc-component-def__row-button--danger"
            aria-label="删除事件"
            @click="removeEvent(index)"
          >
            删除
          </button>
        </div>

        <input
          v-model="row.description"
          type="text"
          autocomplete="off"
          placeholder="用途说明"
          aria-label="事件说明"
        />

        <details>
          <summary>事件参数</summary>
          <textarea
            v-model="row.paramsText"
            class="lc-component-def__options"
            rows="2"
            spellcheck="false"
            placeholder="每行一个：名称 或 名称=类型"
            aria-label="事件参数"
          />
        </details>
      </div>

      <p v-if="draft.events.length === 0" class="lc-component-def__empty">
        还没有对外事件，页面只能对它的位置与属性做反应。
      </p>

      <button type="button" class="lc-component-def__add" @click="addEvent">+ 添加事件</button>
    </section>

    <section class="lc-component-def__section">
      <h3 class="lc-component-def__title">
        插槽
        <span class="lc-component-def__count">{{ draft.slots.length }}</span>
      </h3>
      <p class="lc-component-def__hint">
        声明后组件即为容器：往实例上拖物料时，落点命中哪一格就归档到哪个插槽。要让内容真的显示出来，
        需在蓝图里放一个「插槽出口」物料并填同样的插槽名；没有出口的插槽不会被渲染。
      </p>
      <p v-if="sectionError('slots').length" class="lc-component-def__error" role="alert">
        {{ sectionError('slots').join('；') }}
      </p>

      <div v-for="(row, index) in draft.slots" :key="index" class="lc-component-def__event">
        <div class="lc-component-def__event-line">
          <input
            v-model="row.name"
            class="lc-component-def__mono"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="插槽名，如 header"
            aria-label="插槽名"
          />
          <input
            v-model="row.title"
            type="text"
            autocomplete="off"
            placeholder="显示标题"
            aria-label="插槽标题"
          />
          <button
            type="button"
            class="lc-component-def__row-button lc-component-def__row-button--danger"
            aria-label="删除插槽"
            @click="removeSlot(index)"
          >
            删除
          </button>
        </div>

        <div class="lc-component-def__slot-line">
          <input
            v-model="row.acceptsText"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="允许物料，逗号分隔；留空不限"
            aria-label="允许放入的物料"
          />
          <input
            v-model="row.maxText"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            placeholder="上限"
            aria-label="最多子节点数"
          />
        </div>

        <input
          v-model="row.description"
          type="text"
          autocomplete="off"
          placeholder="用途说明"
          aria-label="插槽说明"
        />

        <details>
          <summary>命中区域（容器百分比）</summary>
          <div class="lc-component-def__region">
            <label class="lc-component-def__region-field">
              <span>X</span>
              <input
                v-model="row.x"
                type="text"
                inputmode="numeric"
                spellcheck="false"
                placeholder="0"
              />
            </label>
            <label class="lc-component-def__region-field">
              <span>Y</span>
              <input
                v-model="row.y"
                type="text"
                inputmode="numeric"
                spellcheck="false"
                placeholder="0"
              />
            </label>
            <label class="lc-component-def__region-field">
              <span>宽</span>
              <input
                v-model="row.width"
                type="text"
                inputmode="numeric"
                spellcheck="false"
                placeholder="100"
              />
            </label>
            <label class="lc-component-def__region-field">
              <span>高</span>
              <input
                v-model="row.height"
                type="text"
                inputmode="numeric"
                spellcheck="false"
                placeholder="100"
              />
            </label>
          </div>
          <p class="lc-component-def__hint">四项一起填才生效；留空表示这一格覆盖整个容器。</p>
        </details>
      </div>

      <p v-if="draft.slots.length === 0" class="lc-component-def__empty">
        还没有插槽，页面无法往这个组件里放内容。
      </p>

      <button type="button" class="lc-component-def__add" @click="addSlot">+ 添加插槽</button>
    </section>
  </div>
</template>

<style scoped>
.lc-component-def {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.lc-component-def__section {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.lc-component-def__title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: var(--lc-text);
  font-size: 12px;
  font-weight: 600;
}

.lc-component-def__count {
  padding: 1px 6px;
  border: 1px solid var(--lc-border);
  border-radius: 999px;
  color: var(--lc-text-muted);
  font-size: 10px;
  font-weight: 400;
}

.lc-component-def__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.lc-component-def__label {
  color: var(--lc-text-secondary);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.lc-component-def__label em {
  margin-left: 2px;
  color: var(--lc-danger);
  font-style: normal;
}

.lc-component-def input,
.lc-component-def textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 5px 7px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
  line-height: 1.5;
}

.lc-component-def input:focus,
.lc-component-def textarea:focus {
  border-color: var(--lc-accent);
  outline: 1px solid var(--lc-accent);
}

.lc-component-def__mono {
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
}

.lc-component-def__options {
  resize: vertical;
}

.lc-component-def__hint {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 10px;
  line-height: 1.5;
}

.lc-component-def__hint code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
}

.lc-component-def__error {
  margin: 0;
  padding: 5px 7px;
  border: 1px solid var(--lc-danger-border);
  border-radius: 6px;
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 10px;
  line-height: 1.5;
}

.lc-component-def__empty {
  margin: 0;
  padding: 9px;
  border: 1px dashed var(--lc-border);
  border-radius: 6px;
  color: var(--lc-text-muted);
  font-size: 10px;
}

.lc-component-def__prop {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px;
  border: 1px solid var(--lc-border);
  border-radius: 7px;
  background: var(--lc-surface-sunken);
}

.lc-component-def__prop-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 5px;
  align-items: center;
}

.lc-component-def__prop-line:last-of-type {
  grid-template-columns: 104px minmax(0, 1fr);
}

.lc-component-def__event {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px;
  border: 1px solid var(--lc-border);
  border-radius: 7px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-size: 10px;
}

.lc-component-def__event summary {
  cursor: pointer;
  user-select: none;
}

.lc-component-def__event-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 5px;
  align-items: center;
}

.lc-component-def__slot-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 84px;
  gap: 5px;
  align-items: center;
}

.lc-component-def__region {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 5px;
  margin-top: 6px;
}

.lc-component-def__region-field {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  color: var(--lc-text-muted);
  font-size: 10px;
}

.lc-component-def__region-field input {
  min-width: 0;
  padding: 4px 6px;
  font-size: 11px;
}

.lc-component-def__row-button,
.lc-component-def__add {
  height: 22px;
  padding: 0 7px;
  border: 1px solid var(--lc-border);
  border-radius: 5px;
  background: var(--lc-surface);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 10px;
  cursor: pointer;
}

.lc-component-def__add {
  align-self: flex-start;
}

.lc-component-def__row-button:hover,
.lc-component-def__add:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-component-def__row-button--danger {
  border-color: var(--lc-danger-border);
  color: var(--lc-danger);
}

@media (prefers-reduced-motion: reduce) {
  .lc-component-def__row-button,
  .lc-component-def__add {
    transition: none;
  }
}
</style>
