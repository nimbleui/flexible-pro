<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type {
  DocumentService,
  JsonSchema,
  MaterialService,
  SelectionService,
  SetterKind,
  SetterService,
} from '@lc/contracts'
import type {
  ExpressionEngine,
  FunctionDescriptor,
  NodeSchema,
  PropOption,
  PropType,
  PropValue,
  SchemaPatch,
} from '@lc/schema'
import { isExpressionString, nodePath } from '@lc/schema'
import type { ScopeSymbol } from '@lc/expression/editor'
import { buildPageSymbols } from '@lc/expression/editor'
import { useAppContext } from '@lc/vue'
import ExpressionPropEditor from './ExpressionPropEditor.vue'

defineProps<{
  /** 宿主传入的只读上下文 */
  context?: Record<string, unknown>
}>()

const ctx = useAppContext()
const document = ctx.get<DocumentService>('document')
const selection = ctx.get<SelectionService>('selection')
const material = ctx.get<MaterialService>('material')
const setter = ctx.get<SetterService>('setter')
const expression = ctx.get<ExpressionEngine>('expression')

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
  if (material) disposables.push(material.onDidChange(bump))
  if (setter) disposables.push(setter.onDidChange(bump))
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

const materialEntry = computed(() => {
  const current = node.value
  return current ? material?.get(current.componentName) : undefined
})

/** 一个可编辑属性在面板里的渲染描述，由物料 JSON Schema 推导而来。 */
interface PropField {
  /** 写入 `node.props` 的键名，同时作为表达式模式的本地 key */
  key: string
  /** 表单标题；schema 没给 `title` 时退回键名，保证不会出现空标签 */
  title: string
  /** setter 服务解析出的控件形态；未注册对应 setter 时是 `text` */
  kind: SetterKind
  /** 枚举候选项，只有 `kind === 'select'` 时被读取；由 schema 的 `enum` 映射而来 */
  options: Array<{
    /** 展示名：枚举值原样转字符串，没有本地化文案 */
    label: string
    /** 写回 `node.props` 的值，保持 schema 里的原始类型 */
    value: string | number | boolean
  }>
}

function toPropType(definition: JsonSchema): PropType {
  if (definition.format === 'color') return 'color'
  if (Array.isArray(definition.enum)) return 'enum'
  switch (definition.type) {
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'object':
      return 'object'
    case 'array':
      return 'array'
    default:
      return 'string'
  }
}

function toOptions(definitions: unknown): PropOption[] {
  if (!Array.isArray(definitions)) return []
  return definitions
    .filter(
      (value): value is string | number | boolean =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
    )
    .map((value) => ({ label: String(value), value }))
}

const propFields = computed<PropField[]>(() => {
  const schema = materialEntry.value?.props as JsonSchema | undefined
  const properties = (schema?.properties ?? {}) as Record<string, JsonSchema>
  return Object.entries(properties).map(([key, definition]) => {
    const propType = toPropType(definition)
    return {
      key,
      title: typeof definition.title === 'string' ? definition.title : key,
      kind: setter?.resolve(propType)?.kind ?? 'text',
      options: toOptions(definition.enum),
    }
  })
})

/** 表达式模式是编辑器本地状态，不写进 schema；切换节点时清空 */
const expressionModes = reactive<Record<string, boolean>>({})

watch(
  () => node.value?.id,
  () => {
    for (const key of Object.keys(expressionModes)) delete expressionModes[key]
  },
)

function isExpressionValue(value: unknown): boolean {
  return isExpressionString(value) || (typeof value === 'string' && value.includes('{{'))
}

function isExpressionField(field: PropField): boolean {
  if (field.kind !== 'text') return false
  const explicit = expressionModes[field.key]
  return explicit === undefined ? isExpressionValue(propValue(field.key)) : explicit
}

function toggleExpression(field: PropField): void {
  expressionModes[field.key] = !isExpressionField(field)
}

/** 属性表达式的作用域与画布一致，额外补上当前节点的循环变量 */
const expressionSymbols = computed<ScopeSymbol[]>(() => {
  version.value
  const schema = document?.model.schema
  if (!schema) return []

  const symbols = buildPageSymbols(schema)
  const current = node.value
  if (current?.loop) {
    symbols.push({
      name: current.loop.itemName ?? '$item',
      kind: 'unknown',
      source: 'loop',
      description: '当前循环项',
    })
    symbols.push({
      name: current.loop.indexName ?? '$index',
      kind: 'number',
      source: 'loop',
      description: '当前循环下标',
    })
  }
  return symbols
})

const expressionFunctions = computed<readonly FunctionDescriptor[]>(() => {
  version.value
  return expression?.functions.describe() ?? []
})

function commit(patches: SchemaPatch[], label = '修改属性'): void {
  if (!document || !node.value || patches.length === 0) return
  document.apply(patches, { record: true, label })
}

/**
 * 当前选中节点下的 patch 路径。
 *
 * 节点 id 要经 `nodePath` 转义：文档里的 id 可能带 `/` 或 `~`，直接拼进路径会写到
 * 别的容器上。没有选中节点时返回空串，`commit()` 在写文档前已经拦下这种调用。
 */
function path(suffix: string): string {
  return node.value ? nodePath(node.value.id, suffix) : ''
}

function propValue(key: string): unknown {
  return node.value?.props?.[key]
}

function propText(key: string): string {
  const value = propValue(key)
  if (value === undefined || value === null) return ''
  if (isExpressionString(value)) return value.raw
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function propBool(key: string): boolean {
  return propValue(key) === true
}

function propColor(key: string): string {
  const value = propValue(key)
  return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
    ? value
    : '#ffffff'
}

function commitProp(key: string, event: Event): void {
  const input = event.target as HTMLInputElement | HTMLSelectElement
  const value: PropValue =
    input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value
  commit([{ op: 'replace', path: path(`props/${key}`), value }], '修改属性')
}

function commitPropNumber(key: string, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  commit([{ op: 'replace', path: path(`props/${key}`), value }], '修改属性')
}

/** 字符串属性的表达式模式直接保存原始模板文本，渲染时按 {{ }} 求值 */
function commitExpression(key: string, raw: string): void {
  commit([{ op: 'replace', path: path(`props/${key}`), value: raw }], '修改属性表达式')
}
</script>

<template>
  <div class="lc-props">
    <template v-if="!node">
      <div class="lc-props__empty">
        {{
          selectionCount > 1
            ? `已选中 ${selectionCount} 个节点，请单选后编辑属性`
            : '选中画布节点查看属性'
        }}
      </div>
    </template>

    <template v-else>
      <div class="lc-props__header">
        <span class="lc-props__name">{{ node.componentName }}</span>
        <span class="lc-props__id">{{ node.id }}</span>
      </div>

      <section v-if="propFields.length > 0" class="lc-props__section">
        <h4>组件属性</h4>
        <div class="lc-props__grid">
          <div
            v-for="field in propFields"
            :key="field.key"
            class="lc-props__field"
            :class="{ 'lc-props__field--wide': isExpressionField(field) }"
          >
            <div class="lc-props__field-head">
              <span>{{ field.title }}</span>
              <button
                v-if="field.kind === 'text'"
                type="button"
                class="lc-props__expression-toggle"
                :class="{ 'is-active': isExpressionField(field) }"
                :aria-pressed="isExpressionField(field)"
                :title="
                  isExpressionField(field)
                    ? '退出表达式模式'
                    : '表达式模式：在 {{ }} 内使用页面数据与函数'
                "
                @click="toggleExpression(field)"
              >
                fx
              </button>
            </div>

            <ExpressionPropEditor
              v-if="isExpressionField(field)"
              :key="`${node?.id}:${field.key}`"
              :model-value="propText(field.key)"
              :symbols="expressionSymbols"
              :functions="expressionFunctions"
              :label="field.title"
              @commit="commitExpression(field.key, $event)"
            />

            <template v-else>
              <input
                v-if="field.kind === 'number'"
                type="number"
                :value="propText(field.key)"
                @change="commitPropNumber(field.key, $event)"
              />
              <input
                v-else-if="field.kind === 'color'"
                type="color"
                :value="propColor(field.key)"
                @change="commitProp(field.key, $event)"
              />
              <input
                v-else-if="field.kind === 'toggle'"
                type="checkbox"
                :checked="propBool(field.key)"
                @change="commitProp(field.key, $event)"
              />
              <select
                v-else-if="field.kind === 'select' && field.options.length > 0"
                :value="propText(field.key)"
                @change="commitProp(field.key, $event)"
              >
                <option
                  v-for="option in field.options"
                  :key="String(option.value)"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <input
                v-else
                type="text"
                :value="propText(field.key)"
                @change="commitProp(field.key, $event)"
              />
            </template>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.lc-props {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 12px;
  color: var(--lc-text);
}

.lc-props__empty {
  padding: 12px;
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  text-align: center;
}

.lc-props__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.lc-props__name {
  font-weight: 600;
}

.lc-props__id {
  color: var(--lc-text-secondary);
  font-family: monospace;
  font-size: 11px;
}

.lc-props__section h4 {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--lc-text-secondary);
  letter-spacing: 0.3px;
}

.lc-props__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.lc-props__grid label,
.lc-props__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.lc-props__field--wide {
  grid-column: 1 / -1;
}

.lc-props__field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.lc-props__expression-toggle {
  flex: none;
  height: 18px;
  padding: 0 6px;
  border: 1px solid var(--lc-border);
  border-radius: 4px;
  background: transparent;
  color: var(--lc-text-muted);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: var(--lc-font-size-3xs);
  line-height: 1;
  cursor: pointer;
}

.lc-props__expression-toggle:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-props__expression-toggle.is-active {
  border-color: rgba(55, 182, 255, 0.45);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-props__expression-toggle:focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

.lc-props__grid span {
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-props__grid input,
.lc-props__grid select {
  width: 100%;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface);
  color: var(--lc-text);
  font-size: 12px;
  font-family: inherit;
  box-sizing: border-box;
}

.lc-props__grid input[type='color'] {
  padding: 2px;
}

.lc-props__grid input[type='checkbox'] {
  height: 16px;
  width: 16px;
}
</style>
