<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type {
  DocumentService,
  JsonSchema,
  MaterialService,
  SelectionService,
  SetterKind,
  SetterService,
} from '@lc/contracts'
import type { NodeSchema, PropOption, PropType, PropValue, Rect, SchemaPatch } from '@lc/schema'
import { nodePath } from '@lc/schema'
import { useAppContext } from '@lc/vue'

defineProps<{
  /** 宿主传入的只读上下文 */
  context?: Record<string, unknown>
}>()

const ctx = useAppContext()
const document = ctx.get<DocumentService>('document')
const selection = ctx.get<SelectionService>('selection')
const material = ctx.get<MaterialService>('material')
const setter = ctx.get<SetterService>('setter')

const version = ref(0)
const disposables: Array<{ dispose(): void }> = []

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

const rect = computed<Rect | undefined>(() => {
  const current = node.value?.layout?.rect
  return current ? { ...current } : undefined
})

const materialEntry = computed(() => {
  const current = node.value
  return current ? material?.get(current.componentName) : undefined
})

interface PropField {
  key: string
  title: string
  kind: SetterKind
  options: Array<{ label: string; value: string | number | boolean }>
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

const styleValue = computed<Record<string, unknown>>(() => {
  version.value
  return (node.value?.style as Record<string, unknown> | undefined) ?? {}
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

function commitRect(field: keyof Rect, event: Event): void {
  const input = event.target as HTMLInputElement
  const value = Number(input.value)
  if (!Number.isFinite(value)) return

  const current = rect.value ?? { x: 0, y: 0, width: 100, height: 40 }
  const next = {
    ...current,
    [field]: field === 'width' || field === 'height' ? Math.max(1, value) : value,
  }
  commit([{ op: 'replace', path: path('layout/rect'), value: next }], '修改位置尺寸')
}

function commitLayout(field: 'rotate' | 'zIndex', event: Event): void {
  const input = event.target as HTMLInputElement
  const value = Number(input.value)
  if (!Number.isFinite(value)) return
  const label = field === 'rotate' ? '修改旋转' : '修改层级'
  commit([{ op: 'replace', path: path(`layout/${field}`), value }], label)
}

function commitStyle(field: string, event: Event): void {
  const input = event.target as HTMLInputElement
  const value = field === 'opacity' ? Number(input.value) : input.value
  if (field === 'opacity' && !Number.isFinite(value)) return
  commit([{ op: 'replace', path: path(`style/${field}`), value }], '修改样式')
}

function propValue(key: string): unknown {
  return node.value?.props?.[key]
}

function propText(key: string): string {
  const value = propValue(key)
  if (value === undefined || value === null) return ''
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

      <section class="lc-props__section">
        <h4>位置与尺寸</h4>
        <div class="lc-props__grid">
          <label>
            <span>X</span>
            <input type="number" :value="rect?.x ?? 0" @change="commitRect('x', $event)" />
          </label>
          <label>
            <span>Y</span>
            <input type="number" :value="rect?.y ?? 0" @change="commitRect('y', $event)" />
          </label>
          <label>
            <span>宽</span>
            <input
              type="number"
              :value="rect?.width ?? 0"
              @change="commitRect('width', $event)"
            />
          </label>
          <label>
            <span>高</span>
            <input
              type="number"
              :value="rect?.height ?? 0"
              @change="commitRect('height', $event)"
            />
          </label>
          <label>
            <span>角度</span>
            <input
              type="number"
              step="1"
              :value="node.layout?.rotate ?? 0"
              @change="commitLayout('rotate', $event)"
            />
          </label>
          <label>
            <span>层级</span>
            <input
              type="number"
              step="1"
              :value="node.layout?.zIndex ?? 0"
              @change="commitLayout('zIndex', $event)"
            />
          </label>
        </div>
      </section>

      <section class="lc-props__section">
        <h4>样式</h4>
        <div class="lc-props__grid">
          <label>
            <span>内边距</span>
            <input
              type="text"
              placeholder="如 12px"
              :value="String(styleValue.padding ?? '')"
              @change="commitStyle('padding', $event)"
            />
          </label>
          <label>
            <span>圆角</span>
            <input
              type="text"
              placeholder="如 8px"
              :value="String(styleValue.borderRadius ?? '')"
              @change="commitStyle('borderRadius', $event)"
            />
          </label>
          <label>
            <span>背景</span>
            <input
              type="color"
              :value="
                typeof styleValue.backgroundColor === 'string'
                  ? styleValue.backgroundColor
                  : '#ffffff'
              "
              @change="commitStyle('backgroundColor', $event)"
            />
          </label>
          <label>
            <span>透明度</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.1"
              :value="typeof styleValue.opacity === 'number' ? styleValue.opacity : 1"
              @change="commitStyle('opacity', $event)"
            />
          </label>
        </div>
      </section>

      <section v-if="propFields.length > 0" class="lc-props__section">
        <h4>组件属性</h4>
        <div class="lc-props__grid">
          <label v-for="field in propFields" :key="field.key">
            <span>{{ field.title }}</span>

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
          </label>
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

.lc-props__grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
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
