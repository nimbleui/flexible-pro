<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { ExpressionEngine, FunctionDescriptor, ValidationIssue } from '@lc/schema'
import { isBuiltinFunction, isValidFunctionName } from '@lc/expression'
import type { ScopeSymbol } from '@lc/expression/editor'
import {
  METHOD_DOCS,
  PROPERTY_DOCS,
  RECEIVER_LABELS,
  scopeSymbolFromType,
} from '@lc/expression/editor'
import type {
  FunctionScope,
  GlobalFunction,
  GlobalFunctionInput,
} from '../../functions/global-functions'
import {
  onGlobalFunctionsChange,
  removeGlobalFunction,
  resolveFunctionScope,
  saveGlobalFunction,
} from '../../functions/global-functions'
import type { FunctionConsoleDraft } from '../../functions/function-draft'
import {
  consoleDraftFrom,
  createParamNode,
  schemaFromDraft,
} from '../../functions/function-draft'
import type { FunctionPublishStatus } from '../../functions/function-status'
import { functionContentMatches, functionPublishStatus } from '../../functions/function-status'
import type { ProjectRelease } from '../../projects/release-model'
import {
  checkProjectRelease,
  currentReleaseOf,
  listReleasesOf,
  publishProject,
  releases,
} from '../../projects/release-store'
import { toastService } from '../../toast'
import type { NamedTypeOption, TypeNodeDraft } from '../common/type-node'
import { valueTypeFromTypeNode } from '../common/type-node'
import FilterSelect from '../common/FilterSelect.vue'
import TypeNodeEditor from '../common/TypeNodeEditor.vue'
import FunctionCodeBox from './FunctionCodeBox.vue'
import FunctionTestPanel from './FunctionTestPanel.vue'

/**
 * 函数控制台右侧的编辑区。
 *
 * 草稿由管理页按条目 id 缓存后传入（切换选中项不丢未保存修改），本组件只负责
 * 校验、五个页签的呈现与保存 / 发布 / 复制 / 删除动作；落库成功后把结果抛回父级，
 * 由父级决定 URL 与选中项怎么走。
 */

const props = defineProps<{
  /** 当前条目的缓存草稿；组件直接原地编辑，父级持有同一份响应式对象 */
  draft: FunctionConsoleDraft
  /** 已保存的记录；null 表示新建，尚未落库 */
  saved: GlobalFunction | null
  /** 归属项目 id */
  projectId: string
  /** 校验函数体与试跑共用的表达式引擎 */
  engine: ExpressionEngine
  /** 已占用的函数名（不含正在编辑的这一条） */
  takenNames: readonly string[]
  /** 可引用的已定义类型 */
  typeOptions: readonly NamedTypeOption[]
}>()

const emit = defineEmits<{
  /** 保存或发布成功；父级据此把新建 URL 换成真实 id */
  (event: 'saved', fn: GlobalFunction): void
  /** 删除成功；父级清理草稿缓存并改选下一条 */
  (event: 'removed', id: string): void
  /** 复制成功；父级选中新条目 */
  (event: 'duplicated', fn: GlobalFunction): void
}>()

type TabId = 'basic' | 'code' | 'params' | 'examples' | 'versions'

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'basic', label: '基本信息' },
  { id: 'code', label: '代码编辑' },
  { id: 'params', label: '参数配置' },
  { id: 'examples', label: '使用示例' },
  { id: 'versions', label: '版本管理' },
]

const SCOPE_OPTIONS: ReadonlyArray<{ value: FunctionScope; label: string; hint: string }> = [
  { value: 'global', label: '全局', hint: '跨页面复用的通用计算' },
  { value: 'page', label: '页面', hint: '面向单个页面的业务逻辑' },
  { value: 'private', label: '私有', hint: '仅供内部调用的辅助函数' },
]

const STATUS_META: Readonly<Record<FunctionPublishStatus, { label: string; tone: string }>> = {
  published: { label: '已发布', tone: 'success' },
  modified: { label: '有改动', tone: 'warning' },
  draft: { label: '未发布', tone: 'muted' },
}

const tab = ref<TabId>('basic')
const moreOpen = ref(false)
const saveError = ref('')
const codeBox = ref<InstanceType<typeof FunctionCodeBox> | null>(null)

interface DraftErrors {
  /** 函数名：必填、标识符合法、不与内置函数或其他已占用名冲突 */
  name?: string
  /** 形参：整组共用一条文案 */
  params?: string
  /** 函数体：必填 + 引擎编译得到的原始报错文案 */
  body?: string
}

const errors = ref<DraftErrors>({})

/** 发布弹层：打开时现算闸门清单，避免常驻 computed 跟着每次按键重算全项目资产 */
const publishOpen = ref(false)
const publishNote = ref('')
const publishError = ref('')
const publishIssues = ref<readonly ValidationIssue[]>([])
const deleteOpen = ref(false)

const blockingIssues = computed(() =>
  publishIssues.value.filter((issue) => issue.severity === 'error'),
)

/** 注册表不是响应式源；全局函数变化时递增它，让目录与补全重新取值 */
const catalogVersion = ref(0)
let offCatalog: { dispose(): void } | null = null

const catalog = computed<readonly FunctionDescriptor[]>(() => {
  catalogVersion.value
  return props.engine.functions.describe()
})

/** 函数体只暴露形参：页面数据不进入纯函数作用域，需要时由调用方作为实参传入 */
const symbols = computed<readonly ScopeSymbol[]>(() =>
  props.draft.params
    .filter((param) => param.name.trim() !== '')
    .map((param) =>
      scopeSymbolFromType(param.name.trim(), valueTypeFromTypeNode(param), {
        source: 'param',
        description: param.description.trim() || undefined,
      }),
    ),
)

const publishStatus = computed<FunctionPublishStatus>(() => {
  // 订阅快照表：发布 / 回滚后徽标要跟着变，currentReleaseOf 本身不是响应式读取
  void releases.value
  if (!props.saved) return 'draft'
  return functionPublishStatus(props.saved, props.projectId)
})

/** 草稿与已保存内容是否一致；新建时只要填过任何字段就算有内容 */
const dirty = computed(() => {
  const draft = props.draft
  if (!props.saved) {
    return (
      draft.name.trim() !== '' ||
      draft.body.trim() !== '' ||
      draft.title.trim() !== '' ||
      draft.description.trim() !== '' ||
      draft.params.length > 0
    )
  }

  const schema = schemaFromDraft(draft)
  const body = typeof schema.body === 'string' ? schema.body : schema.body.raw
  const saved = props.saved
  return (
    schema.name !== saved.name ||
    body !== saved.body ||
    schema.title !== (saved.title ?? '') ||
    schema.description !== (saved.description ?? '') ||
    draft.scope !== resolveFunctionScope(saved.scope) ||
    JSON.stringify(schema.params ?? []) !== JSON.stringify(saved.params ?? []) ||
    JSON.stringify(schema.paramTypes ?? {}) !== JSON.stringify(saved.paramTypes ?? {})
  )
})

const displayName = computed(() => props.draft.name.trim() || '未命名函数')

const signaturePreview = computed(() => {
  const params = props.draft.params
    .map((param) => param.name.trim())
    .filter((name) => name !== '')
  return `${props.draft.name.trim() || 'fn'}(${params.join(', ')})`
})

/** 版本管理：包含这条函数的项目快照，按新到旧；按 id 匹配，改名也能认出来 */
const versions = computed<
  ReadonlyArray<{
    release: ProjectRelease
    fn: GlobalFunction
    live: boolean
    matches: boolean
  }>
>(() => {
  void releases.value
  const saved = props.saved
  if (!saved) return []

  const liveRevision = currentReleaseOf(props.projectId)?.revision

  return listReleasesOf(props.projectId)
    .flatMap((release) => {
      const fn = release.assets.functions.find((item) => item.id === saved.id)
      if (!fn) return []
      return [
        {
          release,
          fn,
          live: release.revision === liveRevision,
          matches: functionContentMatches(fn, saved),
        },
      ]
    })
    .reverse()
})

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

/** 示例实参：填过示例值的叶节点用示例值（字符串补引号），其余退回形参名占位 */
function exampleArg(param: TypeNodeDraft): string {
  const name = param.name.trim()
  const text = param.valueText.trim()
  if (text === '') return name
  if (param.kind === 'number' || param.kind === 'boolean') return text
  if (param.kind === 'object' || param.kind === 'array') return text
  return JSON.stringify(text)
}

const exampleCall = computed(() => {
  const args = props.draft.params.filter((param) => param.name.trim() !== '').map(exampleArg)
  return `${props.draft.name.trim() || 'fn'}(${args.join(', ')})`
})

const exampleSnippets = computed(() => [
  {
    title: '表达式调用',
    hint: '在属性绑定、事件动作的表达式输入框中直接调用。',
    code: exampleCall.value,
  },
  {
    title: '模板文本',
    hint: '在文本内容里用 {{ }} 插值，渲染时求值。',
    code: `结果：{{ ${exampleCall.value} }}`,
  },
  {
    title: '流程 / 事件赋值',
    hint: '在流程「赋值」节点或事件动作里，把调用结果写入页面数据。',
    code: exampleCall.value,
  },
])

const typeSelectOptions = [{ value: 'normal', label: '普通函数' }]

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function clearError(field: keyof DraftErrors): void {
  errors.value = { ...errors.value, [field]: undefined }
}

function addParam(): void {
  props.draft.params.push(createParamNode())
  clearError('params')
}

function removeParam(index: number): void {
  props.draft.params.splice(index, 1)
  clearError('params')
}

function validateName(): void {
  const name = props.draft.name.trim()
  if (name === '') {
    errors.value.name = '请填写函数名'
  } else if (!isValidFunctionName(name)) {
    errors.value.name = '函数名需以文字、下划线或 $ 开头，且不能是 null / true 等字面量'
  } else if (isBuiltinFunction(name)) {
    errors.value.name = `「${name}」是内置函数，请换一个名字`
  } else if (props.takenNames.includes(name)) {
    errors.value.name = `「${name}」已被其他函数占用`
  }
}

function validateParams(): void {
  const seen = new Set<string>()
  for (const param of props.draft.params) {
    const paramName = param.name.trim()
    if (paramName === '') {
      errors.value.params = '形参名不能为空'
      break
    }
    if (!isValidFunctionName(paramName)) {
      errors.value.params = `形参「${paramName}」不是合法标识符`
      break
    }
    if (seen.has(paramName)) {
      errors.value.params = `形参「${paramName}」重复`
      break
    }
    seen.add(paramName)
  }
}

/** 语法判定完全交给引擎 compile，报错原文直接呈现，不在表单里另写一套文法 */
function validateBody(): void {
  const body = props.draft.body.trim()
  if (body === '') {
    errors.value.body = '请填写函数体表达式'
    return
  }

  try {
    props.engine.compile(body)
  } catch (error) {
    errors.value.body = error instanceof Error ? error.message : String(error)
  }
}

/**
 * 提交前校验：清空旧错误后逐段重算，并把页签切到第一处错误所在位置。
 *
 * @returns 可以提交时为 true；副作用是 errors 被整体重写一次
 */
function validate(): boolean {
  errors.value = {}

  validateName()
  validateParams()
  validateBody()

  if (errors.value.name) {
    tab.value = 'basic'
    return false
  }
  if (errors.value.params) {
    tab.value = 'params'
    return false
  }
  if (errors.value.body) {
    tab.value = 'basic'
    return false
  }
  return true
}

/** 草稿 → 存储输入；标题与说明在控制台里都是可选字段，空白由存储层归一 */
function buildInput(): GlobalFunctionInput {
  const schema = schemaFromDraft(props.draft)

  return {
    id: props.saved?.id,
    name: schema.name,
    title: schema.title,
    params: schema.params,
    paramTypes: schema.paramTypes,
    body: typeof schema.body === 'string' ? schema.body : schema.body.raw,
    description: schema.description,
    scope: props.draft.scope,
    projectId: props.projectId,
  }
}

function onSave(): void {
  saveError.value = ''
  if (!validate()) {
    toastService.show('请先修正标红的字段', 'error')
    return
  }

  try {
    const entry = saveGlobalFunction(buildInput())
    emit('saved', entry)
    toastService.show(
      props.saved ? `函数「${entry.name}」已保存` : `函数「${entry.name}」已创建并注册`,
      'success',
    )
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
  }
}

function openPublish(): void {
  saveError.value = ''
  if (!validate()) {
    toastService.show('请先修正标红的字段', 'error')
    return
  }

  publishNote.value = ''
  publishError.value = ''
  publishIssues.value = checkProjectRelease(props.projectId)
  publishOpen.value = true
}

/**
 * 发布 = 先保存当前草稿，再把整个项目的当前内容冻结为新版本。
 *
 * 复用项目发布 machinery：闸门不通过时 publishProject 抛错，原因原样展示，
 * 不在这里绕过校验单独发布函数。
 */
function confirmPublish(): void {
  publishError.value = ''

  try {
    const entry = saveGlobalFunction(buildInput())
    const release = publishProject(props.projectId, { note: publishNote.value })
    emit('saved', entry)
    publishOpen.value = false
    toastService.show(
      `已发布 v${release.revision}，函数「${entry.name}」进入线上版本`,
      'success',
    )
  } catch (error) {
    publishError.value = error instanceof Error ? error.message : String(error)
  }
}

/** 复制当前草稿为新函数：名字自动避开已占用名，内容沿用草稿（含未保存修改） */
function onDuplicate(): void {
  moreOpen.value = false
  saveError.value = ''
  if (!validate()) {
    toastService.show('请先修正标红的字段', 'error')
    return
  }

  const taken = new Set(props.takenNames)
  const base = `${props.draft.name.trim()}_copy`
  let name = base
  let index = 2
  while (taken.has(name)) {
    name = `${base}${index}`
    index += 1
  }

  try {
    const entry = saveGlobalFunction({ ...buildInput(), id: undefined, name })
    emit('duplicated', entry)
    toastService.show(`已复制为「${entry.name}」`, 'success')
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
  }
}

function onRemove(): void {
  const saved = props.saved
  if (!saved) return

  removeGlobalFunction(saved.id)
  deleteOpen.value = false
  emit('removed', saved.id)
  toastService.show(`函数「${saved.name}」已删除`, 'success')
}

/** 新建条目没有可删除的记录，菜单里对应动作是清空草稿 */
function resetDraft(): void {
  moreOpen.value = false
  Object.assign(props.draft, consoleDraftFrom(null))
  errors.value = {}
  saveError.value = ''
}

async function copySnippet(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code)
    toastService.show('示例已复制到剪贴板', 'success')
  } catch {
    toastService.show('复制失败：当前环境不允许访问剪贴板', 'error')
  }
}

/** 参考面板点击函数名：在当前光标处插入调用前缀；无参函数直接补上 () */
function insertFunction(descriptor: FunctionDescriptor): void {
  const text = descriptor.params.length === 0 ? `${descriptor.name}()` : `${descriptor.name}(`
  codeBox.value?.insert(text)
  clearError('body')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  moreOpen.value = false
  publishOpen.value = false
  deleteOpen.value = false
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  offCatalog = onGlobalFunctionsChange(() => {
    catalogVersion.value += 1
  })
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  offCatalog?.dispose()
  offCatalog = null
})
</script>

<template>
  <section class="lc-fnd">
    <header class="lc-fnd__head">
      <span class="lc-fnd__icon" aria-hidden="true">&lt;/&gt;</span>
      <div class="lc-fnd__heading">
        <div class="lc-fnd__name-row">
          <h2 class="lc-fnd__name">{{ displayName }}</h2>
          <span
            class="lc-fnd__status"
            :class="`lc-fnd__status--${STATUS_META[publishStatus].tone}`"
          >
            {{ STATUS_META[publishStatus].label }}
          </span>
          <span v-if="dirty" class="lc-fnd__dirty">● 未保存</span>
        </div>
        <code class="lc-fnd__signature">{{ signaturePreview }}</code>
      </div>

      <div class="lc-fnd__actions">
        <button type="button" class="lc-fnd__button" @click="onSave">保存</button>
        <button
          type="button"
          class="lc-fnd__button lc-fnd__button--publish"
          @click="openPublish"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
              d="M14.5 1.5 7 9M14.5 1.5l-4.8 13-2.7-5.5L1.5 6.3z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linejoin="round"
            />
          </svg>
          发布
        </button>
        <div class="lc-fnd__more">
          <button
            type="button"
            class="lc-fnd__button lc-fnd__button--icon"
            aria-label="更多操作"
            :aria-expanded="moreOpen"
            @click="moreOpen = !moreOpen"
          >
            更多
            <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
              <path d="m3 6 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" />
            </svg>
          </button>
          <div v-if="moreOpen" class="lc-fnd__menu" role="menu">
            <button
              type="button"
              role="menuitem"
              class="lc-fnd__menu-item"
              @click="onDuplicate"
            >
              复制函数
            </button>
            <button
              v-if="saved"
              type="button"
              role="menuitem"
              class="lc-fnd__menu-item lc-fnd__menu-item--danger"
              @click="deleteOpen = true"
            >
              删除函数
            </button>
            <button
              v-else
              type="button"
              role="menuitem"
              class="lc-fnd__menu-item"
              @click="resetDraft"
            >
              清空草稿
            </button>
          </div>
        </div>
      </div>
    </header>

    <p v-if="saveError" class="lc-fnd__error" role="alert">{{ saveError }}</p>

    <nav class="lc-fnd__tabs" aria-label="函数编辑页签">
      <button
        v-for="item in TABS"
        :key="item.id"
        type="button"
        class="lc-fnd__tab"
        :class="{ 'lc-fnd__tab--active': tab === item.id }"
        :aria-current="tab === item.id ? 'page' : undefined"
        @click="tab = item.id"
      >
        {{ item.label }}
      </button>
    </nav>

    <div class="lc-fnd__body">
      <!-- 基本信息 -->
      <div v-if="tab === 'basic'" class="lc-fnd__pane">
        <div class="lc-fnd__grid">
          <label class="lc-fnd__field">
            <span class="lc-fnd__label">函数名称 <em aria-hidden="true">*</em></span>
            <input
              v-model="draft.name"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="如 formatDate"
              @input="clearError('name')"
            />
            <span v-if="errors.name" class="lc-fnd__field-error" role="alert">{{
              errors.name
            }}</span>
          </label>

          <div class="lc-fnd__field">
            <span class="lc-fnd__label">
              函数类型
              <span
                class="lc-fnd__info"
                title="表达式引擎只支持纯表达式函数：输入形参，返回求值结果，没有副作用语句。"
                >ⓘ</span
              >
            </span>
            <FilterSelect
              model-value="normal"
              :options="typeSelectOptions"
              aria-label="函数类型"
            />
          </div>
        </div>

        <label class="lc-fnd__field">
          <span class="lc-fnd__label">函数描述</span>
          <input
            v-model="draft.description"
            type="text"
            autocomplete="off"
            placeholder="说明函数用途、输入与返回值"
          />
        </label>

        <div class="lc-fnd__field">
          <span class="lc-fnd__label">
            作用域
            <span
              class="lc-fnd__info"
              title="分类只影响管理页的筛选与徽标；运行时注册仍是应用级，所有页面都能按名字调用。"
              >ⓘ</span
            >
          </span>
          <div class="lc-fnd__scopes" role="radiogroup" aria-label="作用域">
            <label
              v-for="option in SCOPE_OPTIONS"
              :key="option.value"
              class="lc-fnd__scope"
              :class="{ 'lc-fnd__scope--active': draft.scope === option.value }"
              :title="option.hint"
            >
              <input v-model="draft.scope" type="radio" name="fn-scope" :value="option.value" />
              {{ option.label }}
            </label>
          </div>
        </div>

        <div class="lc-fnd__field">
          <FunctionCodeBox
            v-model="draft.body"
            :functions="catalog"
            :symbols="symbols"
            :min-height="180"
            @update:model-value="clearError('body')"
          />
          <span v-if="errors.body" class="lc-fnd__field-error" role="alert">{{
            errors.body
          }}</span>
          <span class="lc-fnd__hint">
            纯表达式，只能访问形参与已注册函数；输入时自动提示，Ctrl+Space 手动呼出。
          </span>
        </div>

        <details class="lc-fnd__advanced">
          <summary class="lc-fnd__advanced-summary">
            <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
              <path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" />
            </svg>
            高级配置
          </summary>
          <div class="lc-fnd__advanced-body">
            <label class="lc-fnd__field">
              <span class="lc-fnd__label">展示标题</span>
              <input
                v-model="draft.title"
                type="text"
                autocomplete="off"
                placeholder="可选，用于目录与补全里的友好名称"
              />
            </label>
            <dl class="lc-fnd__meta">
              <div v-if="saved">
                <dt>条目 ID</dt>
                <dd>
                  <code>{{ saved.id }}</code>
                </dd>
              </div>
              <div v-if="saved">
                <dt>最后修改</dt>
                <dd>{{ formatTime(saved.updatedAt) }}</dd>
              </div>
              <div>
                <dt>归属项目</dt>
                <dd>
                  <code>{{ projectId }}</code>
                </dd>
              </div>
            </dl>
          </div>
        </details>
      </div>

      <!-- 代码编辑 -->
      <div v-else-if="tab === 'code'" class="lc-fnd__pane">
        <FunctionCodeBox
          ref="codeBox"
          v-model="draft.body"
          :functions="catalog"
          :symbols="symbols"
          :min-height="300"
          @update:model-value="clearError('body')"
        />
        <span v-if="errors.body" class="lc-fnd__field-error" role="alert">{{
          errors.body
        }}</span>

        <FunctionTestPanel
          :engine="engine"
          :name="draft.name"
          :params="draft.params"
          :body="draft.body"
        />

        <details class="lc-fnd__advanced">
          <summary class="lc-fnd__advanced-summary">
            <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
              <path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" />
            </svg>
            可用函数与表达式方法
            <span class="lc-fnd__advanced-count"
              >{{ catalog.length }} 个函数 · {{ methodCount }} 个方法</span
            >
          </summary>
          <div class="lc-fnd__catalog">
            <section
              v-for="group in catalogGroups"
              :key="group.scope"
              class="lc-fnd__catalog-group"
            >
              <h5>{{ group.label }}</h5>
              <div class="lc-fnd__catalog-items">
                <button
                  v-for="fn in group.items"
                  :key="`${group.scope}-${fn.name}`"
                  type="button"
                  class="lc-fnd__catalog-entry"
                  :title="fn.description || fn.title || fn.name"
                  @click="insertFunction(fn)"
                >
                  <code>{{ fn.name }}({{ fn.params.join(', ') }})</code>
                  <span v-if="fn.title">{{ fn.title }}</span>
                </button>
              </div>
            </section>

            <section class="lc-fnd__catalog-group">
              <h5>表达式方法</h5>
              <div class="lc-fnd__catalog-items">
                <span
                  v-for="property in propertyChips"
                  :key="property.name"
                  class="lc-fnd__catalog-chip"
                  :title="property.description"
                >
                  <code>{{ property.name }}</code>
                  <span>{{ property.receiverText }}</span>
                </span>
              </div>
              <div
                v-for="group in methodGroups"
                :key="group.receiver"
                class="lc-fnd__catalog-methods"
              >
                <span class="lc-fnd__catalog-receiver">{{ group.label }}</span>
                <div class="lc-fnd__catalog-items">
                  <span
                    v-for="method in group.items"
                    :key="`${group.receiver}-${method.name}`"
                    class="lc-fnd__catalog-chip"
                    :title="method.description"
                  >
                    <code>{{ method.signature }}</code>
                  </span>
                </div>
              </div>
            </section>
          </div>
        </details>
      </div>

      <!-- 参数配置 -->
      <div v-else-if="tab === 'params'" class="lc-fnd__pane">
        <div class="lc-fnd__signature-bar">
          <code>{{ signaturePreview }}</code>
          <span>形参按声明顺序传入；类型标注用于补全、试跑与示例生成。</span>
        </div>

        <div v-if="draft.params.length > 0" class="lc-fnd__params">
          <TypeNodeEditor
            v-for="(param, index) in draft.params"
            :key="index"
            :node="param"
            :type-options="typeOptions"
            show-name
            show-value
            removable
            @remove="removeParam(index)"
          />
        </div>
        <p v-else class="lc-fnd__empty-hint">
          还没有形参；无参函数可以直接在函数体里使用已注册函数与字面量。
        </p>

        <button type="button" class="lc-fnd__param-add" @click="addParam">+ 添加形参</button>
        <span v-if="errors.params" class="lc-fnd__field-error" role="alert">{{
          errors.params
        }}</span>
      </div>

      <!-- 使用示例 -->
      <div v-else-if="tab === 'examples'" class="lc-fnd__pane">
        <p v-if="draft.name.trim() === ''" class="lc-fnd__empty-hint">
          函数名为空，示例先用占位名 fn；填好函数名后示例会自动更新。
        </p>

        <div v-if="draft.params.length > 0" class="lc-fnd__example-params">
          <h4 class="lc-fnd__pane-title">形参速览</h4>
          <table class="lc-fnd__table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(param, index) in draft.params" :key="index">
                <td>
                  <code>{{ param.name.trim() || '（未命名）' }}</code>
                </td>
                <td>{{ param.kind }}</td>
                <td>{{ param.description.trim() || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <section
          v-for="snippet in exampleSnippets"
          :key="snippet.title"
          class="lc-fnd__snippet"
        >
          <div class="lc-fnd__snippet-head">
            <h4>{{ snippet.title }}</h4>
            <button
              type="button"
              class="lc-fnd__snippet-copy"
              @click="copySnippet(snippet.code)"
            >
              复制
            </button>
          </div>
          <p class="lc-fnd__snippet-hint">{{ snippet.hint }}</p>
          <pre class="lc-fnd__snippet-code"><code>{{ snippet.code }}</code></pre>
        </section>
      </div>

      <!-- 版本管理 -->
      <div v-else class="lc-fnd__pane">
        <p v-if="!saved" class="lc-fnd__empty-hint">
          新建函数还没有版本记录：保存并发布后，这里会列出包含该函数的项目快照。
        </p>
        <p v-else-if="versions.length === 0" class="lc-fnd__empty-hint">
          该函数还没有进入任何发布版本；点右上角「发布」把它冻结进项目快照。
        </p>

        <ul v-else class="lc-fnd__versions">
          <li v-for="item in versions" :key="item.release.revision" class="lc-fnd__version">
            <div class="lc-fnd__version-head">
              <span class="lc-fnd__version-rev">v{{ item.release.revision }}</span>
              <span v-if="item.live" class="lc-fnd__chip lc-fnd__chip--success">当前线上</span>
              <span
                class="lc-fnd__chip"
                :class="item.matches ? 'lc-fnd__chip--muted' : 'lc-fnd__chip--warning'"
              >
                {{ item.matches ? '与当前内容一致' : '与当前内容有差异' }}
              </span>
              <span class="lc-fnd__version-time">
                {{ formatTime(item.release.createdAt) }} ·
                {{ item.release.publishedBy ?? '本地用户' }}
              </span>
            </div>
            <p v-if="item.release.note" class="lc-fnd__version-note">{{ item.release.note }}</p>
            <pre class="lc-fnd__snippet-code"><code>{{ item.fn.body }}</code></pre>
          </li>
        </ul>
      </div>
    </div>

    <div v-if="moreOpen" class="lc-fnd__backdrop" @click="moreOpen = false" />

    <!-- 发布确认 -->
    <Teleport to="body">
      <div v-if="publishOpen" class="lc-fnd__scrim" @click.self="publishOpen = false">
        <section
          class="lc-fnd__dialog"
          role="dialog"
          aria-modal="true"
          aria-label="发布项目新版本"
        >
          <header class="lc-fnd__dialog-head">
            <h3>发布项目新版本</h3>
            <button
              type="button"
              class="lc-fnd__dialog-close"
              aria-label="关闭"
              @click="publishOpen = false"
            >
              ×
            </button>
          </header>
          <p class="lc-fnd__dialog-hint">
            发布会先保存当前函数草稿，再把整个项目的当前内容冻结为新版本；运行页读取的是发布快照。
          </p>

          <ul v-if="blockingIssues.length > 0" class="lc-fnd__issues">
            <li v-for="(issue, index) in blockingIssues" :key="index">{{ issue.message }}</li>
          </ul>

          <label v-else class="lc-fnd__field">
            <span class="lc-fnd__label">发布备注（可选）</span>
            <textarea v-model="publishNote" rows="2" placeholder="如：新增 formatDate 函数" />
          </label>

          <p v-if="publishError" class="lc-fnd__error" role="alert">{{ publishError }}</p>

          <footer class="lc-fnd__dialog-actions">
            <button type="button" class="lc-fnd__button" @click="publishOpen = false">
              取消
            </button>
            <button
              type="button"
              class="lc-fnd__button lc-fnd__button--publish"
              :disabled="blockingIssues.length > 0"
              @click="confirmPublish"
            >
              确认发布
            </button>
          </footer>
        </section>
      </div>
    </Teleport>

    <!-- 删除确认 -->
    <Teleport to="body">
      <div v-if="deleteOpen" class="lc-fnd__scrim" @click.self="deleteOpen = false">
        <section class="lc-fnd__dialog" role="dialog" aria-modal="true" aria-label="删除函数">
          <header class="lc-fnd__dialog-head">
            <h3>删除函数「{{ saved?.name }}」？</h3>
            <button
              type="button"
              class="lc-fnd__dialog-close"
              aria-label="关闭"
              @click="deleteOpen = false"
            >
              ×
            </button>
          </header>
          <p class="lc-fnd__dialog-hint">
            删除后，表达式里对 {{ saved?.name }}()
            的调用会失败；已发布快照里的历史副本不受影响。此操作不可撤销。
          </p>
          <footer class="lc-fnd__dialog-actions">
            <button type="button" class="lc-fnd__button" @click="deleteOpen = false">
              取消
            </button>
            <button
              type="button"
              class="lc-fnd__button lc-fnd__button--danger"
              @click="onRemove"
            >
              删除
            </button>
          </footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.lc-fnd {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* ---------------------------------------------------------------------------
   头部：图标 + 名称 + 状态 + 动作
--------------------------------------------------------------------------- */

.lc-fnd__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px 12px;
}

.lc-fnd__icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--lc-accent), var(--lc-accent-2));
  box-shadow: 0 0 18px var(--lc-glow-soft);
  color: var(--lc-on-accent);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
  font-weight: 700;
}

.lc-fnd__heading {
  flex: 1;
  min-width: 0;
}

.lc-fnd__name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.lc-fnd__name {
  margin: 0;
  overflow: hidden;
  color: var(--lc-text);
  font-size: 16px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-fnd__status {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 16px;
}

.lc-fnd__status--success {
  background: color-mix(in srgb, var(--lc-success) 16%, transparent);
  color: var(--lc-success);
}

.lc-fnd__status--warning {
  background: color-mix(in srgb, var(--lc-warning) 16%, transparent);
  color: var(--lc-warning);
}

.lc-fnd__status--muted {
  background: var(--lc-accent-soft);
  color: var(--lc-text-secondary);
}

.lc-fnd__dirty {
  flex: none;
  color: var(--lc-warning);
  font-size: 10px;
}

.lc-fnd__signature {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  color: var(--lc-text-muted);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-fnd__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

.lc-fnd__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.lc-fnd__button:hover {
  border-color: var(--lc-border-strong);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-fnd__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.lc-fnd__button--publish {
  border-color: var(--lc-accent);
  background: linear-gradient(
    135deg,
    var(--lc-accent-bright),
    var(--lc-accent) 55%,
    var(--lc-accent-2)
  );
  box-shadow: 0 0 16px var(--lc-glow-soft);
  color: var(--lc-on-accent);
  font-weight: 600;
}

.lc-fnd__button--publish:hover {
  border-color: var(--lc-accent-bright);
  color: var(--lc-on-accent);
}

.lc-fnd__button--danger {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-fnd__button--danger:hover {
  border-color: var(--lc-danger);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-fnd__more {
  position: relative;
}

.lc-fnd__menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  min-width: 132px;
  padding: 4px;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
}

.lc-fnd__menu-item {
  padding: 7px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.lc-fnd__menu-item:hover {
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-fnd__menu-item--danger:hover {
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-fnd__backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
}

.lc-fnd__error {
  margin: 0 20px 8px;
  padding: 8px 10px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 12px;
  line-height: 1.5;
}

/* ---------------------------------------------------------------------------
   页签
--------------------------------------------------------------------------- */

.lc-fnd__tabs {
  display: flex;
  flex: none;
  gap: 2px;
  padding: 0 20px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-fnd__tab {
  position: relative;
  padding: 9px 14px;
  border: none;
  background: transparent;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease;
}

.lc-fnd__tab:hover {
  color: var(--lc-text);
}

.lc-fnd__tab--active {
  color: var(--lc-accent-bright);
  font-weight: 600;
}

.lc-fnd__tab--active::after {
  content: '';
  position: absolute;
  right: 10px;
  bottom: -1px;
  left: 10px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--lc-accent-bright), var(--lc-accent-2));
  box-shadow: 0 0 8px var(--lc-glow);
}

.lc-fnd__body {
  flex: 1;
  min-height: 0;
  padding: 18px 20px 24px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--lc-border-strong) transparent;
}

.lc-fnd__body::-webkit-scrollbar,
.lc-fnd__catalog::-webkit-scrollbar {
  width: 8px;
}

.lc-fnd__body::-webkit-scrollbar-track,
.lc-fnd__catalog::-webkit-scrollbar-track {
  background: transparent;
}

.lc-fnd__body::-webkit-scrollbar-thumb,
.lc-fnd__catalog::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: var(--lc-border-strong);
}

.lc-fnd__body::-webkit-scrollbar-thumb:hover,
.lc-fnd__catalog::-webkit-scrollbar-thumb:hover {
  background: var(--lc-accent);
}

.lc-fnd__pane {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 860px;
}

/* ---------------------------------------------------------------------------
   表单字段
--------------------------------------------------------------------------- */

.lc-fnd__grid {
  display: grid;
  grid-template-columns: 1fr 220px;
  gap: 14px;
}

.lc-fnd__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.lc-fnd__label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--lc-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.lc-fnd__label em {
  color: var(--lc-danger);
  font-style: normal;
}

.lc-fnd__info {
  color: var(--lc-text-muted);
  font-size: 11px;
  cursor: help;
}

.lc-fnd__field input,
.lc-fnd__field textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
}

.lc-fnd__field textarea {
  resize: vertical;
}

.lc-fnd__field input:focus,
.lc-fnd__field textarea:focus {
  border-color: var(--lc-accent);
  outline: 1px solid var(--lc-accent);
}

.lc-fnd__field-error {
  color: var(--lc-danger);
  font-size: 11px;
  line-height: 1.45;
}

.lc-fnd__hint {
  color: var(--lc-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.lc-fnd__scopes {
  display: flex;
  gap: 8px;
}

.lc-fnd__scope {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.lc-fnd__scope input {
  accent-color: var(--lc-accent);
  margin: 0;
}

.lc-fnd__scope--active {
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

/* ---------------------------------------------------------------------------
   高级配置 / 目录
--------------------------------------------------------------------------- */

.lc-fnd__advanced {
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
}

.lc-fnd__advanced-summary {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  color: var(--lc-text-secondary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}

.lc-fnd__advanced-summary svg {
  transition: transform 0.15s ease;
}

.lc-fnd__advanced[open] > .lc-fnd__advanced-summary svg {
  transform: rotate(90deg);
}

.lc-fnd__advanced-count {
  margin-left: auto;
  color: var(--lc-text-muted);
  font-size: 10px;
  font-weight: 400;
}

.lc-fnd__advanced-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 12px 12px;
  border-top: 1px solid var(--lc-border);
}

.lc-fnd__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin: 0;
}

.lc-fnd__meta div {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.lc-fnd__meta dt {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-fnd__meta dd {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-fnd__meta code {
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 10px;
}

.lc-fnd__catalog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 260px;
  padding: 4px 12px 12px;
  overflow-y: auto;
  border-top: 1px solid var(--lc-border);
  scrollbar-width: thin;
  scrollbar-color: var(--lc-border-strong) transparent;
}

.lc-fnd__catalog-group h5 {
  margin: 8px 0 5px;
  color: var(--lc-text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.lc-fnd__catalog-items {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.lc-fnd__catalog-entry,
.lc-fnd__catalog-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  padding: 4px 7px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 10px;
}

.lc-fnd__catalog-entry {
  cursor: pointer;
}

.lc-fnd__catalog-entry:hover {
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
}

.lc-fnd__catalog-entry code,
.lc-fnd__catalog-chip code {
  color: var(--lc-accent-bright);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 10px;
}

.lc-fnd__catalog-entry span,
.lc-fnd__catalog-chip span {
  color: var(--lc-text-muted);
}

.lc-fnd__catalog-methods {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}

.lc-fnd__catalog-receiver {
  color: var(--lc-text-muted);
  font-size: 10px;
}

/* ---------------------------------------------------------------------------
   参数配置
--------------------------------------------------------------------------- */

.lc-fnd__signature-bar {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
}

.lc-fnd__signature-bar code {
  color: var(--lc-accent-bright);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
}

.lc-fnd__signature-bar span {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-fnd__params {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lc-fnd__param-add {
  align-self: flex-start;
  height: 28px;
  padding: 0 12px;
  border: 1px dashed var(--lc-border-strong);
  border-radius: var(--lc-radius-sm);
  background: transparent;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-fnd__param-add:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-fnd__empty-hint {
  margin: 0;
  padding: 14px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-sm);
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

/* ---------------------------------------------------------------------------
   使用示例
--------------------------------------------------------------------------- */

.lc-fnd__pane-title {
  margin: 0 0 8px;
  color: var(--lc-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.lc-fnd__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.lc-fnd__table th,
.lc-fnd__table td {
  padding: 7px 10px;
  border: 1px solid var(--lc-border);
  text-align: left;
}

.lc-fnd__table th {
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.lc-fnd__table td {
  color: var(--lc-text);
}

.lc-fnd__table code {
  color: var(--lc-accent-bright);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
}

.lc-fnd__snippet {
  padding: 12px 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
}

.lc-fnd__snippet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.lc-fnd__snippet-head h4 {
  margin: 0;
  color: var(--lc-text);
  font-size: 12px;
  font-weight: 600;
}

.lc-fnd__snippet-copy {
  padding: 3px 10px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface);
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.lc-fnd__snippet-copy:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-fnd__snippet-hint {
  margin: 4px 0 8px;
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-fnd__snippet-code {
  margin: 0;
  padding: 9px 11px;
  overflow-x: auto;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface);
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ---------------------------------------------------------------------------
   版本管理
--------------------------------------------------------------------------- */

.lc-fnd__versions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-fnd__version {
  padding: 12px 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
}

.lc-fnd__version-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.lc-fnd__version-rev {
  color: var(--lc-accent-bright);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 13px;
  font-weight: 700;
}

.lc-fnd__chip {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 16px;
}

.lc-fnd__chip--success {
  background: color-mix(in srgb, var(--lc-success) 16%, transparent);
  color: var(--lc-success);
}

.lc-fnd__chip--warning {
  background: color-mix(in srgb, var(--lc-warning) 16%, transparent);
  color: var(--lc-warning);
}

.lc-fnd__chip--muted {
  background: var(--lc-accent-soft);
  color: var(--lc-text-secondary);
}

.lc-fnd__version-time {
  margin-left: auto;
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-fnd__version-note {
  margin: 6px 0 8px;
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-fnd__version .lc-fnd__snippet-code {
  margin-top: 8px;
}

/* ---------------------------------------------------------------------------
   弹层
--------------------------------------------------------------------------- */

.lc-fnd__scrim {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(2, 8, 20, 0.62);
  backdrop-filter: blur(3px);
}

.lc-fnd__dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(460px, 100%);
  padding: 18px 20px;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
}

.lc-fnd__dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.lc-fnd__dialog-head h3 {
  margin: 0;
  color: var(--lc-text);
  font-size: 14px;
  font-weight: 600;
}

.lc-fnd__dialog-close {
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.lc-fnd__dialog-close:hover {
  border-color: var(--lc-danger-border);
  color: var(--lc-danger);
}

.lc-fnd__dialog-hint {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.lc-fnd__issues {
  margin: 0;
  padding: 10px 12px 10px 28px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 12px;
  line-height: 1.7;
}

.lc-fnd__dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.lc-fnd :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (max-width: 720px) {
  .lc-fnd__grid {
    grid-template-columns: 1fr;
  }

  .lc-fnd__head {
    flex-wrap: wrap;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-fnd__button,
  .lc-fnd__tab,
  .lc-fnd__scope,
  .lc-fnd__advanced-summary svg {
    transition: none;
  }
}
</style>
