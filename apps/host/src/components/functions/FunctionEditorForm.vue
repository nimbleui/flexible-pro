<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { ExpressionEngine, FunctionDescriptor, FunctionSchema } from '@lc/schema'
import { isBuiltinFunction, isValidFunctionName } from '@lc/expression'
import type { ScopeSymbol } from '@lc/expression/editor'
import {
  METHOD_DOCS,
  PROPERTY_DOCS,
  RECEIVER_LABELS,
  scopeSymbolFromType,
} from '@lc/expression/editor'
import type { FunctionDraft } from '../../functions/function-draft'
import { createParamNode, schemaFromDraft } from '../../functions/function-draft'
import { onGlobalFunctionsChange } from '../../functions/global-functions'
import TypeNodeEditor from '../common/TypeNodeEditor.vue'
import FunctionTestPanel from './FunctionTestPanel.vue'
import type { NamedTypeOption } from '../common/type-node'
import { cloneTypeNode, valueTypeFromTypeNode } from '../common/type-node'

/** CodeMirror 体积较大，只在打开函数表单时加载，避免拖进宿主首屏 */
const ExpressionCodeEditor = defineAsyncComponent(() => import('@lc/expression-editor'))

/** ExpressionCodeEditor 通过 defineExpose 暴露的最小面 */
interface CodeEditorExpose {
  /** 在当前光标处插入文本，有选区时替换选区；异步组件未就绪时取到 null，调用方需判空 */
  insert(text: string): void
}

const props = withDefaults(
  defineProps<{
    /** 初始草稿；组件按挂载时的值拷贝一份，切换条目请用 key 重建 */
    initial: FunctionDraft
    /** 用于校验函数体语法；与运行时注册使用同一个引擎 */
    engine: ExpressionEngine
    /** 当前作用域内已占用的函数名（不含正在编辑的这一条） */
    takenNames: readonly string[]
    /** 提交按钮文案 */
    submitLabel?: string
    /** 可引用的已定义类型 */
    typeOptions?: readonly NamedTypeOption[]
  }>(),
  { submitLabel: '保存', typeOptions: () => [] },
)

const emit = defineEmits<{
  (event: 'submit', value: FunctionSchema): void
  (event: 'cancel'): void
}>()

interface DraftErrors {
  /** 函数名：必填、标识符合法、不与内置函数或其他已占用名冲突 */
  name?: string
  /** 标题：仅必填 */
  title?: string
  /** 形参：整组共用一条文案，参数行本身没有逐个错误位 */
  params?: string
  /** 函数体：必填 + 引擎编译得到的原始报错文案 */
  body?: string
  /** 说明：仅必填 */
  description?: string
}

const draft = reactive<FunctionDraft>({
  ...props.initial,
  // 形参节点会被递归增删，必须深拷贝，避免直接改到父组件传入的 initial
  params: props.initial.params.map(cloneTypeNode),
})
const errors = reactive<DraftErrors>({})
const nameInput = ref<HTMLInputElement | null>(null)
const bodyEditor = ref<CodeEditorExpose | null>(null)

/** 注册表不是响应式源；全局函数变化时递增它，让目录与补全重新取值 */
const catalogVersion = ref(0)
let offCatalog: {
  /** 注销变更订阅；Set.delete 幂等，重复调用不会误伤其他订阅者 */
  dispose(): void
} | null = null

const catalog = computed<readonly FunctionDescriptor[]>(() => {
  catalogVersion.value
  return props.engine.functions.describe()
})

/**
 * 函数体只暴露形参：页面数据不进入纯函数作用域，需要时由调用方作为实参传入。
 * 形参类型来自标注；结构示例解析失败时退化为 unknown，不打断输入。
 */
const symbols = computed<readonly ScopeSymbol[]>(() =>
  draft.params
    .filter((param) => param.name.trim() !== '')
    .map((param) =>
      scopeSymbolFromType(param.name.trim(), valueTypeFromTypeNode(param), {
        source: 'param',
        description: param.description.trim() || undefined,
      }),
    ),
)

function addParam(): void {
  draft.params.push(createParamNode())
  clearError('params')
}

function removeParam(index: number): void {
  draft.params.splice(index, 1)
  clearError('params')
}

const SCOPE_LABELS: Readonly<Record<FunctionDescriptor['scope'], string>> = {
  builtin: '内置函数',
  global: '全局函数',
  page: '页面函数',
  material: '物料函数',
}

const SCOPE_ORDER: readonly FunctionDescriptor['scope'][] = [
  'builtin',
  'global',
  'page',
  'material',
]

const catalogGroups = computed(() =>
  SCOPE_ORDER.map((scope) => ({
    scope,
    label: SCOPE_LABELS[scope],
    items: catalog.value.filter((item) => item.scope === scope),
  })).filter((group) => group.items.length > 0),
)

const methodGroups = (['array', 'string', 'number'] as const).map((receiver) => ({
  receiver,
  label: RECEIVER_LABELS[receiver],
  items: METHOD_DOCS[receiver],
}))

// 在脚本里把接收者拼成文本：模板里对导入对象的索引访问会被编译器当成 ref 处理
const propertyChips = PROPERTY_DOCS.map((property) => ({
  ...property,
  receiverText: property.receivers.map((item) => RECEIVER_LABELS[item]).join('/'),
}))

const methodCount =
  METHOD_DOCS.array.length +
  METHOD_DOCS.string.length +
  METHOD_DOCS.number.length +
  PROPERTY_DOCS.length

// 从列表切到表单时原名输入焦点已经随按钮卸载，这里把焦点接回第一个字段
onMounted(() => {
  nameInput.value?.focus()
  offCatalog = onGlobalFunctionsChange(() => {
    catalogVersion.value += 1
  })
})

onUnmounted(() => {
  offCatalog?.dispose()
  offCatalog = null
})

/** 参考面板点击函数名：在当前光标处插入调用前缀；无参函数直接补上 `()` 省掉一次输入 */
function insertFunction(descriptor: FunctionDescriptor): void {
  const text = descriptor.params.length === 0 ? `${descriptor.name}()` : `${descriptor.name}(`
  bodyEditor.value?.insert(text)
  clearError('body')
}

function clearError(field: keyof DraftErrors): void {
  errors[field] = undefined
}

/** 清空上一轮错误：每次提交都从零开始，否则修好一个字段后其它残留文案会一直挂着 */
function clearDraftErrors(): void {
  errors.name = undefined
  errors.title = undefined
  errors.params = undefined
  errors.body = undefined
  errors.description = undefined
}

/**
 * 函数名校验。
 *
 * 合法性与内置重名直接复用引擎的实现，`takenNames` 由父级给出当前作用域已占用的
 * 名字（不含正在编辑的这条），三者共用一份判定，保证「编辑器放行」与「运行时可注册」
 * 不会出现两套结论。
 */
function validateName(): void {
  const name = draft.name.trim()
  if (name === '') {
    errors.name = '请填写函数名'
  } else if (!isValidFunctionName(name)) {
    errors.name = '函数名需以文字、下划线或 $ 开头，且不能是 null / true 等字面量'
  } else if (isBuiltinFunction(name)) {
    errors.name = `「${name}」是内置函数，请换一个名字`
  } else if (props.takenNames.includes(name)) {
    errors.name = `「${name}」已被其他函数占用`
  }
}

/**
 * 形参名校验。
 *
 * 参数列表只有一个共用的错误位，因此遇到第一条非法形参即停止，不再逐行标注：
 * 形参名彼此独立，用户看到「重复」时只需改那一行。
 */
function validateParams(): void {
  const seen = new Set<string>()
  for (const param of draft.params) {
    const paramName = param.name.trim()
    if (paramName === '') {
      errors.params = '形参名不能为空'
      break
    }
    if (!isValidFunctionName(paramName)) {
      errors.params = `形参「${paramName}」不是合法标识符`
      break
    }
    if (seen.has(paramName)) {
      errors.params = `形参「${paramName}」重复`
      break
    }
    seen.add(paramName)
  }
}

/**
 * 函数体校验。
 *
 * 语法判定完全交给引擎 `compile`，报错原文直接呈现：表单里再写一套文法规则
 * 必然与引擎演化分叉。编译产物这里用不上，因此丢弃返回值。
 */
function validateBody(): void {
  const body = draft.body.trim()
  if (body === '') {
    errors.body = '请填写函数体表达式'
    return
  }

  try {
    props.engine.compile(body)
  } catch (error) {
    errors.body = error instanceof Error ? error.message : String(error)
  }
}

/** 是否存在阻断提交的字段错误 */
function hasDraftErrors(): boolean {
  return Boolean(
    errors.name || errors.title || errors.params || errors.body || errors.description,
  )
}

/**
 * 提交前校验：清空旧错误后逐段重算，并把结果写回 `errors` 供模板展示。
 *
 * @returns 可以提交时为 true；副作用是 errors 的五个字段被整体重写一次
 */
function validate(): boolean {
  clearDraftErrors()

  validateName()
  validateParams()
  validateBody()

  if (draft.title.trim() === '') errors.title = '请填写标题'
  if (draft.description.trim() === '') errors.description = '请填写说明'

  return !hasDraftErrors()
}

function onSubmit(): void {
  if (!validate()) return
  emit('submit', schemaFromDraft(draft))
}
</script>

<template>
  <form class="lc-function-form" @submit.prevent="onSubmit">
    <label class="lc-function-form__field">
      <span class="lc-function-form__label">
        函数名
        <em aria-hidden="true">*</em>
      </span>
      <input
        ref="nameInput"
        v-model="draft.name"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="如 progress"
        @input="clearError('name')"
      />
      <span class="lc-function-form__hint"
        >表达式中按此名调用，如 {{ draft.name || 'fn' }}(...)</span
      >
      <span v-if="errors.name" class="lc-function-form__error" role="alert">{{
        errors.name
      }}</span>
    </label>

    <label class="lc-function-form__field">
      <span class="lc-function-form__label">
        标题
        <em aria-hidden="true">*</em>
      </span>
      <input
        v-model="draft.title"
        type="text"
        autocomplete="off"
        placeholder="如：统计完成进度"
        @input="clearError('title')"
      />
      <span v-if="errors.title" class="lc-function-form__error" role="alert">
        {{ errors.title }}
      </span>
    </label>

    <div class="lc-function-form__field">
      <span class="lc-function-form__label">形参</span>

      <div v-if="draft.params.length > 0" class="lc-function-form__params">
        <TypeNodeEditor
          v-for="(param, index) in draft.params"
          :key="index"
          :node="param"
          :type-options="typeOptions"
          show-name
          removable
          @remove="removeParam(index)"
        />
      </div>

      <button type="button" class="lc-function-form__param-add" @click="addParam">
        + 添加形参
      </button>
      <span class="lc-function-form__hint">
        填写名称、类型与说明；对象/数组在下方继续添加字段或元素类型。
      </span>
      <span v-if="errors.params" class="lc-function-form__error" role="alert">
        {{ errors.params }}
      </span>
    </div>

    <div class="lc-function-form__field">
      <span class="lc-function-form__label">
        函数体
        <em aria-hidden="true">*</em>
      </span>
      <ExpressionCodeEditor
        ref="bodyEditor"
        v-model="draft.body"
        :functions="catalog"
        :symbols="symbols"
        aria-label="函数体表达式"
        placeholder="如 list.filter(t => t.done).length + ' / ' + list.length"
        :min-height="110"
        @update:model-value="clearError('body')"
      />
      <span class="lc-function-form__hint">
        纯表达式，只能访问形参与已注册函数；输入时自动提示，句点后提示方法与回调片段，Ctrl+Space
        手动呼出，调用中会在下方显示参数签名。
      </span>
      <span v-if="errors.body" class="lc-function-form__error" role="alert">{{
        errors.body
      }}</span>
    </div>

    <FunctionTestPanel
      :engine="engine"
      :name="draft.name"
      :params="draft.params"
      :body="draft.body"
    />

    <details class="lc-function-form__catalog">
      <summary class="lc-function-form__catalog-summary">
        可用函数与表达式方法
        <span>{{ catalog.length }} 个函数 · {{ methodCount }} 个方法</span>
      </summary>

      <div class="lc-function-form__catalog-body">
        <section
          v-for="group in catalogGroups"
          :key="group.scope"
          class="lc-function-form__catalog-group"
        >
          <h5>{{ group.label }}</h5>
          <div class="lc-function-form__catalog-items">
            <button
              v-for="fn in group.items"
              :key="`${group.scope}-${fn.name}`"
              type="button"
              class="lc-function-form__catalog-entry"
              :title="fn.description || fn.title || fn.name"
              @click="insertFunction(fn)"
            >
              <code>{{ fn.name }}({{ fn.params.join(', ') }})</code>
              <span v-if="fn.title">{{ fn.title }}</span>
            </button>
          </div>
        </section>

        <section class="lc-function-form__catalog-group">
          <h5>表达式方法</h5>

          <div class="lc-function-form__catalog-items">
            <span
              v-for="property in propertyChips"
              :key="property.name"
              class="lc-function-form__catalog-chip"
              :title="property.description"
            >
              <code>{{ property.name }}</code>
              <span>{{ property.receiverText }}</span>
            </span>
          </div>

          <div
            v-for="group in methodGroups"
            :key="group.receiver"
            class="lc-function-form__catalog-methods"
          >
            <span class="lc-function-form__catalog-receiver">{{ group.label }}</span>
            <div class="lc-function-form__catalog-items">
              <span
                v-for="method in group.items"
                :key="`${group.receiver}-${method.name}`"
                class="lc-function-form__catalog-chip"
                :title="method.description"
              >
                <code>{{ method.signature }}</code>
              </span>
            </div>
          </div>
        </section>
      </div>
    </details>

    <label class="lc-function-form__field">
      <span class="lc-function-form__label">
        说明
        <em aria-hidden="true">*</em>
      </span>
      <textarea
        v-model="draft.description"
        rows="2"
        placeholder="说明函数用途、输入与返回值"
        @input="clearError('description')"
      />
      <span v-if="errors.description" class="lc-function-form__error" role="alert">
        {{ errors.description }}
      </span>
    </label>

    <footer class="lc-function-form__actions">
      <button type="button" class="lc-function-form__button" @click="emit('cancel')">
        取消
      </button>
      <button type="submit" class="lc-function-form__button lc-function-form__button--primary">
        {{ submitLabel }}
      </button>
    </footer>
  </form>
</template>

<style scoped>
.lc-function-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lc-function-form__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.lc-function-form__label {
  color: var(--lc-text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.lc-function-form__label em {
  margin-left: 2px;
  color: var(--lc-danger);
  font-style: normal;
}

.lc-function-form__field input,
.lc-function-form__field select,
.lc-function-form__field textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--lc-border);
  border-radius: 7px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
}

.lc-function-form__params {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lc-function-form__param-add {
  align-self: flex-start;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.lc-function-form__param-add:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-function-form__field textarea {
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  resize: vertical;
}

.lc-function-form__field input:focus,
.lc-function-form__field textarea:focus {
  border-color: var(--lc-accent);
  outline: 1px solid var(--lc-accent);
}

.lc-function-form__hint {
  color: var(--lc-text-muted);
  font-size: 10px;
  line-height: 1.45;
}

.lc-function-form__error {
  color: var(--lc-danger);
  font-size: 10px;
  line-height: 1.45;
}

.lc-function-form__catalog {
  border: 1px solid var(--lc-border);
  border-radius: 7px;
  background: rgba(6, 17, 33, 0.5);
}

.lc-function-form__catalog-summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  color: var(--lc-text-secondary);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}

.lc-function-form__catalog-summary span {
  color: var(--lc-text-muted);
  font-size: 10px;
  font-weight: 400;
}

.lc-function-form__catalog-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 240px;
  padding: 0 10px 10px;
  overflow-y: auto;
  border-top: 1px solid var(--lc-border);
}

.lc-function-form__catalog-group h5 {
  margin: 8px 0 5px;
  color: var(--lc-text-secondary);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.lc-function-form__catalog-items {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.lc-function-form__catalog-entry,
.lc-function-form__catalog-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  padding: 4px 7px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 10px;
}

.lc-function-form__catalog-entry {
  cursor: pointer;
}

.lc-function-form__catalog-entry:hover {
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
}

.lc-function-form__catalog-entry:focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

.lc-function-form__catalog-entry code,
.lc-function-form__catalog-chip code {
  color: var(--lc-accent-bright);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 10px;
}

.lc-function-form__catalog-entry span,
.lc-function-form__catalog-chip span {
  color: var(--lc-text-muted);
}

.lc-function-form__catalog-methods {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}

.lc-function-form__catalog-receiver {
  color: var(--lc-text-muted);
  font-size: 10px;
}

.lc-function-form__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 2px;
}

.lc-function-form__button {
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--lc-border);
  border-radius: 7px;
  background: rgba(10, 30, 61, 0.6);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.lc-function-form__button:hover {
  border-color: var(--lc-border-strong);
  background: var(--lc-accent-soft);
}

.lc-function-form__button--primary {
  border-color: rgba(55, 182, 255, 0.55);
  background: linear-gradient(135deg, var(--lc-accent), var(--lc-accent-bright));
  color: var(--lc-on-accent);
  font-weight: 600;
}

.lc-function-form__button--primary:hover {
  border-color: var(--lc-accent-bright);
  background: linear-gradient(135deg, var(--lc-accent-bright), var(--lc-accent-bright));
}

@media (prefers-reduced-motion: reduce) {
  .lc-function-form__button {
    transition: none;
  }
}
</style>
