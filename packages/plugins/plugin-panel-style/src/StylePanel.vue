<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { DocumentService, SelectionService } from '@lc/contracts'
import type { NodeSchema, Rect, SchemaPatch, StyleSchema } from '@lc/schema'
import { nodePath } from '@lc/schema'
import { formatJsonValue, parseJsonDraft } from '@lc/shared'
import { useAppContext } from '@lc/vue'
import { HORIZONTAL_CONSTRAINTS, VERTICAL_CONSTRAINTS } from '@lc/vue'
import BoxSidesEditor from './components/BoxSidesEditor.vue'
import ColorField from './components/ColorField.vue'
import type { BorderPart, BoxProperty, BoxSide, StyleEdit } from './utils/style-fields'
import {
  borderPartEdits,
  boxSideEdits,
  readBorderParts,
  readBoxSides,
  styleValueEdits,
  toPatches,
} from './utils/style-fields'

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

const style = computed<StyleSchema | undefined>(() => node.value?.style)

const rect = computed<Rect | undefined>(() => {
  const current = node.value?.layout?.rect
  return current ? { ...current } : undefined
})

const paddingSides = computed(() => readBoxSides(style.value, 'padding'))
const marginSides = computed(() => readBoxSides(style.value, 'margin'))
const borderParts = computed(() => readBorderParts(style.value))

/**
 * 当前选中节点下的 patch 路径。
 *
 * 节点 id 要经 `nodePath` 转义：文档里的 id 可能带 `/` 或 `~`，直接拼进路径会写到
 * 别的容器上。没有选中节点时返回空串，`commit()` 在写文档前已经拦下这种调用。
 */
function path(suffix: string): string {
  return node.value ? nodePath(node.value.id, suffix) : ''
}

function commit(patches: SchemaPatch[], label = '修改样式'): void {
  if (!document || !node.value || patches.length === 0) return
  document.apply(patches, { record: true, label })
}

/** 样式键的变更统一落到 `style/<key>` 路径 */
function applyEdits(edits: readonly StyleEdit[]): void {
  commit(toPatches(edits, (key) => path(`style/${key}`)))
}

function applyStyleText(key: string, text: string): void {
  applyEdits(styleValueEdits(style.value, key, text))
}

function onStyleField(key: string, event: Event): void {
  applyStyleText(key, (event.target as HTMLInputElement).value)
}

function applyBoxSide(property: BoxProperty, side: BoxSide, text: string): void {
  applyEdits(boxSideEdits(style.value, property, side, text))
}

function onPaddingSide(side: BoxSide, text: string): void {
  applyBoxSide('padding', side, text)
}

function onMarginSide(side: BoxSide, text: string): void {
  applyBoxSide('margin', side, text)
}

function applyBorderPartText(part: BorderPart, text: string): void {
  applyEdits(borderPartEdits(style.value, part, text))
}

function onBorderPart(part: BorderPart, event: Event): void {
  applyBorderPartText(part, (event.target as HTMLInputElement | HTMLSelectElement).value)
}

/** 透明度按协议存数字：写成字符串虽然浏览器认，但会让同一份 schema 有两种类型 */
function onOpacity(event: Event): void {
  const current = node.value?.style?.opacity
  const text = (event.target as HTMLInputElement).value.trim()

  if (text === '') {
    if (current !== undefined) commit([{ op: 'remove', path: path('style/opacity') }])
    return
  }

  const next = Number(text)
  if (!Number.isFinite(next) || next === current) return
  commit([{ op: 'replace', path: path('style/opacity'), value: next }])
}

function opacityText(): string {
  const value = style.value?.opacity
  return typeof value === 'number' ? String(value) : ''
}

/** 输入框回显：数字补 px，与 {@link style-fields} 的读取规则保持一致 */
function styleText(key: string): string {
  const value = style.value?.[key]
  if (typeof value === 'number') return `${value}px`
  return typeof value === 'string' ? value : ''
}

function commitRect(field: keyof Rect, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return

  const current = rect.value ?? { x: 0, y: 0, width: 100, height: 40 }
  const next = {
    ...current,
    [field]: field === 'width' || field === 'height' ? Math.max(1, value) : value,
  }
  commit([{ op: 'replace', path: path('layout/rect'), value: next }], '修改位置尺寸')
}

function commitLayout(field: 'rotate' | 'zIndex', event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  commit(
    [{ op: 'replace', path: path(`layout/${field}`), value }],
    field === 'rotate' ? '修改旋转' : '修改层级',
  )
}

/**
 * 写回单轴锁位约束。
 *
 * 另一轴沿用现值：两轴是独立声明的，改水平锁位不该顺手把垂直锁位重置成默认。
 * 缺省轴不写进 schema，由渲染层按 `left` / `top` 处理，与 Figma 的默认一致。
 */
function commitConstraint(field: 'horizontal' | 'vertical', event: Event): void {
  if (!node.value) return

  const value = (event.target as HTMLSelectElement).value
  const current = node.value.layout?.constraints ?? {}
  commit(
    [
      {
        op: 'replace',
        path: path('layout/constraints'),
        value: { ...current, [field]: value },
      },
    ],
    '修改锁位',
  )
}

/** 锁位下拉的中文标签；center / scale / stretch 两轴同名，共用一份文案 */
const CONSTRAINT_LABELS: Readonly<Record<string, string>> = {
  left: '固定左边',
  right: '固定右边',
  top: '固定上边',
  bottom: '固定下边',
  center: '居中',
  scale: '按比例缩放',
  stretch: '两端拉伸',
}

/** 原始样式 JSON 的本地草稿：半截 JSON 只回错误，不落文档 */
const jsonDraft = ref<string | null>(null)
const jsonError = ref('')

watch(
  () => node.value?.id,
  () => {
    jsonDraft.value = null
    jsonError.value = ''
  },
)

const jsonText = computed(() => jsonDraft.value ?? formatJsonValue(style.value))

function onJsonInput(event: Event): void {
  jsonDraft.value = (event.target as HTMLTextAreaElement).value
  jsonError.value = ''
}

/**
 * 提交原始样式。
 *
 * 只接受扁平对象：数组与标量写进 `node.style` 后渲染层会原样 spread 成内联样式，
 * 得到的是没有意义甚至有害的 CSS，所以在这里直接拦下。
 */
function commitJson(): void {
  if (!node.value) return

  const text = jsonText.value
  const parsed = parseJsonDraft(text)
  if (!parsed.ok) {
    jsonError.value = parsed.error
    return
  }

  jsonDraft.value = null
  jsonError.value = ''

  if (parsed.value === undefined) {
    if (node.value.style !== undefined) commit([{ op: 'remove', path: path('style') }])
    return
  }

  if (typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    jsonError.value = '样式必须是键值对象，不能是数组或单个值'
    return
  }

  commit([{ op: 'replace', path: path('style'), value: parsed.value }], '修改原始样式')
}

const displayOptions = ['block', 'inline-block', 'inline', 'flex', 'grid', 'none']
const overflowOptions = ['visible', 'hidden', 'auto', 'scroll']
const cursorOptions = ['default', 'pointer', 'not-allowed', 'text', 'move', 'crosshair']
const fontWeightOptions = ['normal', '500', '600', 'bold']
const textAlignOptions = ['left', 'center', 'right', 'justify']
const borderStyleOptions = ['solid', 'dashed', 'dotted', 'double', 'none']
</script>

<template>
  <div class="lc-style">
    <div v-if="!node" class="lc-style__empty">
      {{
        selectionCount > 1
          ? `已选中 ${selectionCount} 个节点，请单选后编辑样式`
          : '选中画布节点查看样式'
      }}
    </div>

    <template v-else>
      <div class="lc-style__header">
        <span class="lc-style__name">{{ node.name || node.componentName }}</span>
        <span class="lc-style__id">{{ node.id }}</span>
      </div>

      <section class="lc-style__section">
        <h4>位置与尺寸</h4>
        <div class="lc-style__grid">
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
          <label>
            <span>水平锁位</span>
            <select
              :value="node.layout?.constraints?.horizontal ?? 'left'"
              @change="commitConstraint('horizontal', $event)"
            >
              <option v-for="option in HORIZONTAL_CONSTRAINTS" :key="option" :value="option">
                {{ CONSTRAINT_LABELS[option] }}
              </option>
            </select>
          </label>
          <label>
            <span>垂直锁位</span>
            <select
              :value="node.layout?.constraints?.vertical ?? 'top'"
              @change="commitConstraint('vertical', $event)"
            >
              <option v-for="option in VERTICAL_CONSTRAINTS" :key="option" :value="option">
                {{ CONSTRAINT_LABELS[option] }}
              </option>
            </select>
          </label>
        </div>

        <div class="lc-style__grid">
          <label>
            <span>最小宽</span>
            <input
              type="text"
              placeholder="如 80px"
              :value="styleText('minWidth')"
              @change="onStyleField('minWidth', $event)"
            />
          </label>
          <label>
            <span>最小高</span>
            <input
              type="text"
              placeholder="如 80px"
              :value="styleText('minHeight')"
              @change="onStyleField('minHeight', $event)"
            />
          </label>
          <label>
            <span>最大宽</span>
            <input
              type="text"
              placeholder="如 100%"
              :value="styleText('maxWidth')"
              @change="onStyleField('maxWidth', $event)"
            />
          </label>
          <label>
            <span>最大高</span>
            <input
              type="text"
              placeholder="如 100%"
              :value="styleText('maxHeight')"
              @change="onStyleField('maxHeight', $event)"
            />
          </label>
        </div>
      </section>

      <section class="lc-style__section">
        <h4>内边距</h4>
        <BoxSidesEditor :sides="paddingSides" @commit="onPaddingSide" />
      </section>

      <section class="lc-style__section">
        <h4>外边距</h4>
        <BoxSidesEditor :sides="marginSides" @commit="onMarginSide" />
      </section>

      <section class="lc-style__section">
        <h4>背景与边框</h4>
        <div class="lc-style__grid">
          <ColorField
            label="背景色"
            :value="styleText('backgroundColor')"
            @commit="applyStyleText('backgroundColor', $event)"
          />
          <ColorField
            label="文字色"
            :value="styleText('color')"
            @commit="applyStyleText('color', $event)"
          />
          <label>
            <span>圆角</span>
            <input
              type="text"
              placeholder="如 8px"
              :value="styleText('borderRadius')"
              @change="onStyleField('borderRadius', $event)"
            />
          </label>
          <label>
            <span>阴影</span>
            <input
              type="text"
              placeholder="如 0 2px 8px rgba(0,0,0,.3)"
              :value="styleText('boxShadow')"
              @change="onStyleField('boxShadow', $event)"
            />
          </label>
        </div>

        <div class="lc-style__grid">
          <label>
            <span>边框宽</span>
            <input
              type="text"
              placeholder="如 1px"
              :value="borderParts.width"
              @change="onBorderPart('width', $event)"
            />
          </label>
          <label>
            <span>边框样</span>
            <select :value="borderParts.style" @change="onBorderPart('style', $event)">
              <option value="">不设值</option>
              <option v-for="option in borderStyleOptions" :key="option" :value="option">
                {{ option }}
              </option>
            </select>
          </label>
          <ColorField
            label="边框色"
            :value="borderParts.color"
            @commit="applyBorderPartText('color', $event)"
          />
        </div>
        <p class="lc-style__hint">边框需同时有宽度与线型才会显示。</p>
      </section>

      <section class="lc-style__section">
        <h4>文本</h4>
        <div class="lc-style__grid">
          <label>
            <span>字号</span>
            <input
              type="text"
              placeholder="如 14px"
              :value="styleText('fontSize')"
              @change="onStyleField('fontSize', $event)"
            />
          </label>
          <label>
            <span>行高</span>
            <input
              type="text"
              placeholder="如 1.5"
              :value="styleText('lineHeight')"
              @change="onStyleField('lineHeight', $event)"
            />
          </label>
          <label>
            <span>字重</span>
            <select
              :value="styleText('fontWeight')"
              @change="onStyleField('fontWeight', $event)"
            >
              <option value="">不设值</option>
              <option v-for="option in fontWeightOptions" :key="option" :value="option">
                {{ option }}
              </option>
            </select>
          </label>
          <label>
            <span>对齐</span>
            <select :value="styleText('textAlign')" @change="onStyleField('textAlign', $event)">
              <option value="">不设值</option>
              <option v-for="option in textAlignOptions" :key="option" :value="option">
                {{ option }}
              </option>
            </select>
          </label>
        </div>
      </section>

      <section class="lc-style__section">
        <h4>显示</h4>
        <div class="lc-style__grid">
          <label>
            <span>display</span>
            <select :value="styleText('display')" @change="onStyleField('display', $event)">
              <option value="">不设值</option>
              <option v-for="option in displayOptions" :key="option" :value="option">
                {{ option }}
              </option>
            </select>
          </label>
          <label>
            <span>overflow</span>
            <select :value="styleText('overflow')" @change="onStyleField('overflow', $event)">
              <option value="">不设值</option>
              <option v-for="option in overflowOptions" :key="option" :value="option">
                {{ option }}
              </option>
            </select>
          </label>
          <label>
            <span>cursor</span>
            <select :value="styleText('cursor')" @change="onStyleField('cursor', $event)">
              <option value="">不设值</option>
              <option v-for="option in cursorOptions" :key="option" :value="option">
                {{ option }}
              </option>
            </select>
          </label>
          <label>
            <span>透明度</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              placeholder="1"
              :value="opacityText()"
              @change="onOpacity($event)"
            />
          </label>
        </div>
      </section>

      <section class="lc-style__section">
        <h4>原始样式</h4>
        <textarea
          class="lc-style__json"
          rows="6"
          spellcheck="false"
          :value="jsonText"
          :class="{ 'lc-style__json--invalid': jsonError }"
          aria-label="原始样式 JSON"
          @input="onJsonInput($event)"
          @change="commitJson"
        />
        <p v-if="jsonError" class="lc-style__error" role="alert">{{ jsonError }}</p>
        <p v-else class="lc-style__hint">
          直接编辑整份 style；上面各段写的是 CSS 长手属性，这里可以覆盖任意键。
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.lc-style {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 12px;
  color: var(--lc-text);
}

.lc-style__empty {
  padding: 12px;
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  text-align: center;
}

.lc-style__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.lc-style__name {
  font-weight: 600;
}

.lc-style__id {
  color: var(--lc-text-secondary);
  font-family: monospace;
  font-size: 11px;
}

.lc-style__section h4 {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--lc-text-secondary);
  letter-spacing: 0.3px;
}

.lc-style__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}

.lc-style__grid:last-of-type {
  margin-bottom: 0;
}

.lc-style__grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.lc-style__grid span {
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-style__grid input,
.lc-style__grid select {
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

.lc-style__grid input[type='color'] {
  padding: 2px;
}

.lc-style__json {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface);
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  line-height: 1.5;
  box-sizing: border-box;
  resize: vertical;
}

.lc-style__json--invalid {
  border-color: var(--lc-danger-border);
}

.lc-style__hint {
  margin: 6px 0 0;
  color: var(--lc-text-muted);
  font-size: 10px;
  line-height: 1.5;
}

.lc-style__error {
  margin: 6px 0 0;
  color: var(--lc-danger);
  font-size: 11px;
}
</style>
