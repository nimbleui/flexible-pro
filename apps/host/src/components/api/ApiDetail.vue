<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ProjectApi, ValueTypeSchema } from '@lc/schema'
import type { ApiDraft } from './api-draft'
import { createParamRow, parseApiDraft } from './api-draft'
import type { TypeNodeDraft } from '../common/type-node'
import { valueTypeFromTypeNode } from '../common/type-node'
import TypeNodeEditor from '../common/TypeNodeEditor.vue'
import ToggleSwitch from '../common/ToggleSwitch.vue'
import ApiDebugPanel from './ApiDebugPanel.vue'
import { API_METHOD_OPTIONS, PARAM_TYPE_OPTIONS } from '../../apis/api-model'
import {
  apisOfProject,
  createApi,
  findApiReferences,
  removeApi,
  updateApi,
} from '../../apis/api-store'
import { requestDefaultsOf } from '../../apis/api-config'
import { previewRequestUrl } from '../../apis/api-request'
import { toastService } from '../../toast'

/**
 * 接口详情编辑区（主从布局的右栏）。
 *
 * 五个页签对应接口定义的五件事：是什么（基本）、怎么发（请求）、回来长什么样（响应）、
 * 现在通不通（调试）、凭据与危险操作（高级）。草稿与结果类型由父级按条目 id 缓存后传入，
 * 切换选中不丢未保存修改；「重置 / 用响应填充」需要整体替换草稿，因此交回父级处理。
 *
 * 调试用的是**表单上当前的定义**而不是已保存的那份——填完地址就能发一次，看到响应
 * 再决定要不要保存。
 */

const props = defineProps<{
  /** 当前条目的草稿（父级缓存的同一份响应式对象） */
  draft: ApiDraft
  /** 结果类型草稿（父级缓存的同一份响应式对象） */
  resultDraft: TypeNodeDraft
  /** 已保存的记录；新建时为 null */
  saved: ProjectApi | null
  /** 归属项目 id */
  projectId: string
  /** 是否新建路由 */
  isNew: boolean
}>()

const emit = defineEmits<{
  (event: 'saved', api: ProjectApi): void
  (event: 'removed', id: string): void
  (event: 'reset'): void
  (event: 'capture', body: unknown): void
}>()

const tab = ref<'basic' | 'request' | 'response' | 'debug' | 'advanced'>('basic')
const paramTab = ref<'params' | 'query'>('params')
const tagInput = ref('')
/** 只有点过保存之后才显示校验文案：空表单第一格还没填就报错只是噪声 */
const saveFailed = ref(false)
const pendingDelete = ref(false)

const TABS = [
  { id: 'basic', label: '基本配置' },
  { id: 'request', label: '请求配置' },
  { id: 'response', label: '响应配置' },
  { id: 'debug', label: '调试' },
  { id: 'advanced', label: '高级配置' },
] as const

/** 绝对地址（含协议相对）不拼域名前缀，地址框也就不显示「/」前缀装饰 */
const isAbsolute = computed(() => /^(?:[a-z][a-z\d+\-.]*:)?\/\//i.test(props.draft.path.trim()))

const resultType = computed<ValueTypeSchema | undefined>(() => {
  const type = valueTypeFromTypeNode(props.resultDraft)
  return type.kind === 'unknown' ? undefined : type
})

const parsed = computed(() => parseApiDraft(props.draft, resultType.value))
const requestSpec = computed(() => parsed.value.input ?? null)
const defaults = computed(() => requestDefaultsOf(props.projectId))

const previewUrl = computed(() =>
  requestSpec.value === null ? '' : previewRequestUrl(requestSpec.value, defaults.value),
)

/** 按当前参数行拼出的查询串，供 Query 页签核对 */
const queryString = computed(() => {
  const entries = props.draft.params
    .filter((row) => row.key.trim() !== '')
    .map((row) => [row.key.trim(), row.value])

  return entries.length === 0 ? '' : new URLSearchParams(entries).toString()
})

/** 分组候选：项目里已出现过的分组名，datalist 既可选也可新建 */
const groupOptions = computed(() => {
  const seen = new Set<string>()
  for (const api of apisOfProject(props.projectId)) {
    const group = api.group?.trim()
    if (group) seen.add(group)
  }
  return [...seen]
})

const referenceCount = computed(() =>
  props.saved ? findApiReferences(props.saved.id).length : 0,
)

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function save(): void {
  const input = requestSpec.value
  if (input === null) {
    saveFailed.value = true
    toastService.show(parsed.value.error || '接口定义不完整', 'error')
    return
  }

  try {
    const api = props.saved
      ? updateApi(props.saved.id, input)
      : createApi(input, props.projectId)
    saveFailed.value = false
    toastService.show(`接口「${api.name}」已保存`, 'success')
    emit('saved', api)
  } catch (cause) {
    saveFailed.value = true
    toastService.show(messageOf(cause), 'error')
  }
}

function reset(): void {
  saveFailed.value = false
  pendingDelete.value = false
  emit('reset')
  toastService.show(props.isNew ? '已清空表单' : '已重置为上次保存的内容', 'success')
}

/** 删除走两道：第一次点击进入待确认态，第二次才真的删；仍被引用时由存储层拒绝 */
function askDelete(): void {
  if (!pendingDelete.value) {
    pendingDelete.value = true
    return
  }

  if (!props.saved) return
  try {
    removeApi(props.saved.id)
    pendingDelete.value = false
    toastService.show('接口已删除', 'success')
    emit('removed', props.saved.id)
  } catch (cause) {
    pendingDelete.value = false
    toastService.show(messageOf(cause), 'error')
  }
}

function addTag(): void {
  const tag = tagInput.value.trim()
  tagInput.value = ''
  if (tag === '' || props.draft.tags.includes(tag)) return
  props.draft.tags.push(tag)
}

function onTagKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault()
    addTag()
    return
  }

  if (event.key === 'Backspace' && tagInput.value === '' && props.draft.tags.length > 0) {
    props.draft.tags.pop()
  }
}

function removeTag(index: number): void {
  props.draft.tags.splice(index, 1)
}

function addHeader(): void {
  props.draft.headers.push({ key: '', value: '' })
}

function removeHeader(index: number): void {
  props.draft.headers.splice(index, 1)
  if (props.draft.headers.length === 0) addHeader()
}

function addParam(): void {
  props.draft.params.push(createParamRow())
}

function removeParam(index: number): void {
  props.draft.params.splice(index, 1)
  if (props.draft.params.length === 0) addParam()
}

/** 响应 → 样本与类型：交回父级整体替换草稿，本页签切到响应配置 */
function onDebugCapture(body: unknown): void {
  emit('capture', body)
  tab.value = 'response'
}
</script>

<template>
  <section class="lc-api-detail" aria-label="接口编辑区">
    <header class="lc-api-detail__head">
      <span class="lc-api-detail__method" :data-method="draft.method">{{ draft.method }}</span>
      <div class="lc-api-detail__heading">
        <h2 class="lc-api-detail__title">
          {{ draft.name || (isNew ? '新建接口' : '未命名接口') }}
        </h2>
        <p class="lc-api-detail__subtitle">{{ draft.description || '暂无说明' }}</p>
      </div>
      <div class="lc-api-detail__actions">
        <button type="button" class="lc-api-detail__save" @click="save">保存</button>
        <button type="button" class="lc-api-detail__reset" @click="reset">重置</button>
      </div>
    </header>

    <nav class="lc-api-detail__tabs" role="tablist" aria-label="接口定义分节">
      <button
        v-for="item in TABS"
        :key="item.id"
        type="button"
        role="tab"
        :aria-selected="tab === item.id"
        class="lc-api-detail__tab"
        :class="{ 'is-active': tab === item.id }"
        @click="tab = item.id"
      >
        {{ item.label }}
      </button>
    </nav>

    <div class="lc-api-detail__scroll">
      <section v-show="tab === 'basic'" class="lc-api-detail__pane">
        <div class="lc-api-detail__form">
          <div class="lc-api-detail__field">
            <label class="lc-api-detail__label" for="lc-api-name">
              接口名称 <em class="lc-api-detail__req">*</em>
            </label>
            <input
              id="lc-api-name"
              v-model="draft.name"
              class="lc-api-detail__input"
              placeholder="获取用户信息"
            />
          </div>

          <div class="lc-api-detail__field">
            <span class="lc-api-detail__label">请求方法</span>
            <div class="lc-api-detail__radios" role="radiogroup" aria-label="请求方法">
              <label
                v-for="option in API_METHOD_OPTIONS"
                :key="option.value"
                class="lc-api-detail__radio"
              >
                <input
                  v-model="draft.method"
                  type="radio"
                  name="lc-api-method"
                  :value="option.value"
                />
                {{ option.label }}
              </label>
            </div>
          </div>

          <div class="lc-api-detail__field">
            <label class="lc-api-detail__label" for="lc-api-path">
              接口地址 <em class="lc-api-detail__req">*</em>
            </label>
            <div class="lc-api-detail__path">
              <span v-if="!isAbsolute" class="lc-api-detail__path-prefix" aria-hidden="true"
                >/</span
              >
              <input
                id="lc-api-path"
                v-model="draft.path"
                class="lc-api-detail__input lc-api-detail__input--path"
                placeholder="/api/user/info 或 https://api.test/users"
              />
            </div>
          </div>

          <div class="lc-api-detail__field">
            <span class="lc-api-detail__label">标签</span>
            <div class="lc-api-detail__tags">
              <span v-for="(tag, index) in draft.tags" :key="tag" class="lc-api-detail__tag">
                {{ tag }}
                <button
                  type="button"
                  class="lc-api-detail__tag-x"
                  :aria-label="`移除标签 ${tag}`"
                  @click="removeTag(index)"
                >
                  ×
                </button>
              </span>
              <input
                v-model="tagInput"
                class="lc-api-detail__tag-input"
                placeholder="输入后回车"
                aria-label="新增标签"
                @keydown="onTagKeydown"
                @blur="addTag"
              />
            </div>
          </div>

          <div class="lc-api-detail__field lc-api-detail__field--wide">
            <label class="lc-api-detail__label" for="lc-api-desc">接口说明</label>
            <textarea
              id="lc-api-desc"
              v-model="draft.description"
              class="lc-api-detail__textarea"
              rows="3"
              placeholder="获取当前登录用户的基本信息，包含用户信息、角色等"
            ></textarea>
          </div>

          <div class="lc-api-detail__field">
            <label class="lc-api-detail__label" for="lc-api-group">分组</label>
            <input
              id="lc-api-group"
              v-model="draft.group"
              class="lc-api-detail__input"
              list="lc-api-group-options"
              placeholder="未分组"
            />
            <datalist id="lc-api-group-options">
              <option v-for="group in groupOptions" :key="group" :value="group" />
            </datalist>
          </div>

          <div class="lc-api-detail__field">
            <span class="lc-api-detail__label">是否公开</span>
            <div class="lc-api-detail__public">
              <ToggleSwitch v-model="draft.isPublic" label="是否公开" />
              <span class="lc-api-detail__hint">公开标记，随接口定义保存与导出</span>
            </div>
          </div>
        </div>
      </section>

      <section v-show="tab === 'request'" class="lc-api-detail__pane">
        <div class="lc-api-detail__block">
          <div class="lc-api-detail__block-head">
            <span class="lc-api-detail__block-title">
              请求头
              <span class="lc-api-detail__info" title="空键的行不会发送">ⓘ</span>
            </span>
            <button type="button" class="lc-api-detail__add" @click="addHeader">
              + 添加请求头
            </button>
          </div>
          <table class="lc-api-detail__table">
            <thead>
              <tr>
                <th>参数名</th>
                <th>值</th>
                <th class="lc-api-detail__op">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in draft.headers" :key="index">
                <td>
                  <input
                    v-model="row.key"
                    class="lc-api-detail__cell-input"
                    placeholder="Content-Type"
                    aria-label="请求头名称"
                  />
                </td>
                <td>
                  <input
                    v-model="row.value"
                    class="lc-api-detail__cell-input"
                    placeholder="application/json"
                    aria-label="请求头值"
                  />
                </td>
                <td class="lc-api-detail__op">
                  <button
                    type="button"
                    class="lc-api-detail__trash"
                    :aria-label="`删除请求头第 ${index + 1} 行`"
                    @click="removeHeader(index)"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 6h18" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    </svg>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="lc-api-detail__block">
          <div class="lc-api-detail__block-head">
            <span class="lc-api-detail__block-title">
              请求参数
              <span
                class="lc-api-detail__info"
                title="拼在地址后面；类型 / 必填 / 说明为登记信息，请求按默认值发送"
                >ⓘ</span
              >
            </span>
            <button type="button" class="lc-api-detail__add" @click="addParam">
              + 添加参数
            </button>
          </div>

          <div class="lc-api-detail__subtabs" role="tablist" aria-label="参数视图">
            <button
              type="button"
              role="tab"
              :aria-selected="paramTab === 'params'"
              class="lc-api-detail__subtab"
              :class="{ 'is-active': paramTab === 'params' }"
              @click="paramTab = 'params'"
            >
              Params
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="paramTab === 'query'"
              class="lc-api-detail__subtab"
              :class="{ 'is-active': paramTab === 'query' }"
              @click="paramTab = 'query'"
            >
              Query
            </button>
          </div>

          <table v-show="paramTab === 'params'" class="lc-api-detail__table">
            <thead>
              <tr>
                <th>参数名</th>
                <th class="lc-api-detail__col-type">类型</th>
                <th class="lc-api-detail__col-req">必填</th>
                <th>默认值</th>
                <th>说明</th>
                <th class="lc-api-detail__op">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in draft.params" :key="index">
                <td>
                  <input
                    v-model="row.key"
                    class="lc-api-detail__cell-input"
                    placeholder="userId"
                    aria-label="参数名"
                  />
                </td>
                <td>
                  <select
                    v-model="row.type"
                    class="lc-api-detail__cell-select"
                    aria-label="参数类型"
                  >
                    <option
                      v-for="option in PARAM_TYPE_OPTIONS"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </select>
                </td>
                <td class="lc-api-detail__center">
                  <input v-model="row.required" type="checkbox" aria-label="是否必填" />
                </td>
                <td>
                  <input
                    v-model="row.value"
                    class="lc-api-detail__cell-input"
                    placeholder="-"
                    aria-label="默认值"
                  />
                </td>
                <td>
                  <input
                    v-model="row.description"
                    class="lc-api-detail__cell-input"
                    placeholder="用户ID"
                    aria-label="参数说明"
                  />
                </td>
                <td class="lc-api-detail__op">
                  <button
                    type="button"
                    class="lc-api-detail__trash"
                    :aria-label="`删除参数第 ${index + 1} 行`"
                    @click="removeParam(index)"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 6h18" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    </svg>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-show="paramTab === 'query'" class="lc-api-detail__query">
            <p class="lc-api-detail__hint">
              按当前参数拼出的查询串与完整地址（域名取生效环境）：
            </p>
            <code class="lc-api-detail__query-string">{{
              queryString || '（无查询参数）'
            }}</code>
            <code class="lc-api-detail__query-url">{{
              previewUrl || '填写请求路径后显示完整地址'
            }}</code>
          </div>
        </div>
      </section>

      <section v-show="tab === 'response'" class="lc-api-detail__pane">
        <div class="lc-api-detail__field lc-api-detail__field--narrow">
          <label class="lc-api-detail__label" for="lc-api-responsetype">响应格式</label>
          <select
            id="lc-api-responsetype"
            v-model="draft.responseType"
            class="lc-api-detail__input"
          >
            <option value="json">json</option>
            <option value="text">text</option>
            <option value="blob">blob</option>
          </select>
        </div>

        <div class="lc-api-detail__field">
          <label class="lc-api-detail__label" for="lc-api-sample">响应样本（JSON）</label>
          <textarea
            id="lc-api-sample"
            v-model="draft.sampleText"
            class="lc-api-detail__textarea lc-api-detail__textarea--code"
            rows="8"
            placeholder="样本只服务设计期补全，运行时不会当成数据"
          ></textarea>
        </div>

        <div class="lc-api-detail__field">
          <span class="lc-api-detail__label">结果类型</span>
          <p class="lc-api-detail__hint">
            声明之后，页面表达式里
            <code>data.绑定名</code> 才能补全出字段路径；不声明时按样本推导。
          </p>
          <TypeNodeEditor :node="resultDraft" />
        </div>
      </section>

      <section v-show="tab === 'debug'" class="lc-api-detail__pane">
        <ApiDebugPanel :spec="requestSpec" :project-id="projectId" @capture="onDebugCapture" />
      </section>

      <section v-show="tab === 'advanced'" class="lc-api-detail__pane">
        <label class="lc-api-detail__check">
          <input v-model="draft.withCredentials" type="checkbox" />
          跨域携带凭据
        </label>

        <p v-if="saved" class="lc-api-detail__meta">
          被 {{ referenceCount }} 个页面引用 · 更新于 {{ formatTime(saved.updatedAt) }}
        </p>

        <div v-if="!isNew" class="lc-api-detail__danger">
          <button
            type="button"
            class="lc-api-detail__delete"
            :class="{ 'is-confirm': pendingDelete }"
            @click="askDelete"
          >
            {{ pendingDelete ? '再次点击确认删除' : '删除此接口' }}
          </button>
          <span class="lc-api-detail__hint">仍被页面引用时无法删除，需先在页面里解绑。</span>
        </div>
      </section>

      <p v-if="saveFailed && parsed.error" class="lc-api-detail__error">{{ parsed.error }}</p>
    </div>
  </section>
</template>

<style scoped>
.lc-api-detail {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.lc-api-detail__head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  padding: 16px 18px 12px;
}

.lc-api-detail__method {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: 52px;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--lc-radius-sm);
  background: var(--lc-accent);
  color: var(--lc-on-accent);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
  font-weight: 700;
}

.lc-api-detail__method[data-method='POST'] {
  background: var(--lc-success);
}

.lc-api-detail__method[data-method='PUT'] {
  background: var(--lc-warning);
}

.lc-api-detail__method[data-method='DELETE'] {
  background: var(--lc-danger);
}

.lc-api-detail__method[data-method='PATCH'] {
  background: var(--lc-accent-2);
}

.lc-api-detail__heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.lc-api-detail__title {
  margin: 0;
  overflow: hidden;
  color: var(--lc-text);
  font-size: 16px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-api-detail__subtitle {
  margin: 0;
  overflow: hidden;
  color: var(--lc-text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-api-detail__actions {
  display: flex;
  flex: none;
  gap: 8px;
  margin-left: auto;
}

.lc-api-detail__save,
.lc-api-detail__reset {
  height: 30px;
  padding: 0 16px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color var(--lc-motion-fast) var(--lc-ease-out),
    box-shadow var(--lc-motion-fast) var(--lc-ease-out);
}

.lc-api-detail__save {
  border-color: var(--lc-accent);
  background: linear-gradient(
    135deg,
    var(--lc-accent-bright),
    var(--lc-accent) 55%,
    var(--lc-accent-2)
  );
  box-shadow: 0 0 14px var(--lc-glow-soft);
  color: var(--lc-on-accent);
  font-weight: 600;
}

.lc-api-detail__save:hover {
  box-shadow: 0 0 20px var(--lc-glow);
}

.lc-api-detail__reset:hover {
  border-color: var(--lc-border-strong);
}

.lc-api-detail__tabs {
  display: flex;
  flex: none;
  gap: 4px;
  padding: 0 18px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-api-detail__tab {
  position: relative;
  padding: 8px 12px;
  border: none;
  background: none;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}

.lc-api-detail__tab.is-active {
  color: var(--lc-accent-bright);
  font-weight: 600;
}

.lc-api-detail__tab.is-active::after {
  content: '';
  position: absolute;
  right: 8px;
  bottom: -1px;
  left: 8px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--lc-accent-bright), var(--lc-accent));
  box-shadow: 0 0 8px var(--lc-glow);
}

.lc-api-detail__scroll {
  flex: 1;
  min-height: 0;
  padding: 16px 18px 20px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--lc-border-strong) transparent;
}

.lc-api-detail__scroll::-webkit-scrollbar {
  width: 8px;
}

.lc-api-detail__scroll::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: var(--lc-border-strong);
}

.lc-api-detail__pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.lc-api-detail__form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 24px;
}

.lc-api-detail__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.lc-api-detail__field--wide {
  grid-column: 1 / -1;
}

.lc-api-detail__field--narrow {
  max-width: 240px;
}

.lc-api-detail__label {
  color: var(--lc-text);
  font-size: 12px;
  font-weight: 600;
}

.lc-api-detail__req {
  color: var(--lc-danger);
  font-style: normal;
}

.lc-api-detail__input,
.lc-api-detail__textarea {
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  transition: border-color var(--lc-motion-fast) var(--lc-ease-out);
}

.lc-api-detail__input:focus,
.lc-api-detail__textarea:focus {
  border-color: var(--lc-accent);
}

.lc-api-detail__textarea {
  height: auto;
  min-height: 72px;
  padding: 8px 10px;
  line-height: 1.6;
  resize: vertical;
}

.lc-api-detail__textarea--code {
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
}

.lc-api-detail__path {
  display: flex;
  align-items: stretch;
}

.lc-api-detail__path-prefix {
  display: inline-flex;
  align-items: center;
  padding: 0 10px;
  border: 1px solid var(--lc-border);
  border-right: none;
  border-radius: var(--lc-radius-sm) 0 0 var(--lc-radius-sm);
  background: var(--lc-surface-raised);
  color: var(--lc-text-muted);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
}

.lc-api-detail__input--path {
  flex: 1;
  min-width: 0;
  border-radius: 0 var(--lc-radius-sm) var(--lc-radius-sm) 0;
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
}

.lc-api-detail__path-prefix + .lc-api-detail__input--path {
  border-radius: 0 var(--lc-radius-sm) var(--lc-radius-sm) 0;
}

.lc-api-detail__radios {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  min-height: 30px;
}

.lc-api-detail__radio {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--lc-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.lc-api-detail__radio input {
  accent-color: var(--lc-accent);
  cursor: pointer;
}

.lc-api-detail__tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
}

.lc-api-detail__tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--lc-border-strong);
  border-radius: 4px;
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
  font-size: 11px;
}

.lc-api-detail__tag-x {
  border: none;
  background: none;
  color: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.lc-api-detail__tag-input {
  flex: 1;
  min-width: 80px;
  border: none;
  background: transparent;
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}

.lc-api-detail__public {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
}

.lc-api-detail__hint {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.lc-api-detail__hint code {
  color: var(--lc-text-secondary);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
}

.lc-api-detail__block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lc-api-detail__block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.lc-api-detail__block-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-api-detail__info {
  color: var(--lc-text-muted);
  font-size: 12px;
  cursor: help;
}

.lc-api-detail__add {
  border: none;
  background: none;
  color: var(--lc-accent-bright);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-api-detail__add:hover {
  text-decoration: underline;
}

.lc-api-detail__table {
  width: 100%;
  border-collapse: collapse;
}

.lc-api-detail__table th {
  padding: 6px 8px;
  border: 1px solid var(--lc-hairline);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-muted);
  font-size: 11px;
  font-weight: 500;
  text-align: left;
}

.lc-api-detail__table td {
  padding: 4px 6px;
  border: 1px solid var(--lc-hairline);
}

.lc-api-detail__col-type {
  width: 96px;
}

.lc-api-detail__col-req {
  width: 48px;
}

.lc-api-detail__op {
  width: 48px;
  text-align: center;
}

.lc-api-detail__center {
  text-align: center;
}

.lc-api-detail__center input {
  accent-color: var(--lc-accent);
  cursor: pointer;
}

.lc-api-detail__cell-input,
.lc-api-detail__cell-select {
  width: 100%;
  height: 26px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
}

.lc-api-detail__cell-input:hover,
.lc-api-detail__cell-select:hover {
  border-color: var(--lc-border);
}

.lc-api-detail__cell-input:focus,
.lc-api-detail__cell-select:focus {
  border-color: var(--lc-accent);
  background: var(--lc-surface-sunken);
  outline: none;
}

.lc-api-detail__cell-select {
  cursor: pointer;
}

.lc-api-detail__cell-select option {
  background: var(--lc-surface);
  color: var(--lc-text);
}

.lc-api-detail__trash {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--lc-text-muted);
  cursor: pointer;
}

.lc-api-detail__trash:hover {
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-api-detail__subtabs {
  display: inline-flex;
  align-self: flex-start;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
}

.lc-api-detail__subtab {
  padding: 4px 14px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-api-detail__subtab.is-active {
  background: var(--lc-accent);
  color: var(--lc-on-accent);
  font-weight: 600;
}

.lc-api-detail__query {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--lc-hairline);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
}

.lc-api-detail__query-string,
.lc-api-detail__query-url {
  color: var(--lc-text-secondary);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
  word-break: break-all;
}

.lc-api-detail__query-url {
  color: var(--lc-accent-bright);
}

.lc-api-detail__check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--lc-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.lc-api-detail__check input {
  width: 15px;
  height: 15px;
  accent-color: var(--lc-accent);
  cursor: pointer;
}

.lc-api-detail__meta {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-api-detail__danger {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--lc-hairline);
}

.lc-api-detail__delete {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: none;
  color: var(--lc-danger);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-api-detail__delete.is-confirm {
  background: var(--lc-danger-surface);
  font-weight: 600;
}

.lc-api-detail__error {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 11px;
}

.lc-api-detail :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (max-width: 900px) {
  .lc-api-detail__form {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-api-detail__save,
  .lc-api-detail__reset,
  .lc-api-detail__input,
  .lc-api-detail__textarea {
    transition: none;
  }
}
</style>
