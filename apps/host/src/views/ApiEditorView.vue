<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ValueTypeSchema } from '@lc/schema'
import { formatJsonValue } from '@lc/shared'
import type { ApiDraft } from '../components/api/api-draft'
import { createApiDraft, draftFromApi, parseApiDraft } from '../components/api/api-draft'
import type { TypeNodeDraft } from '../components/common/type-node'
import ApiDebugPanel from '../components/api/ApiDebugPanel.vue'
import ApiKeyValueRows from '../components/api/ApiKeyValueRows.vue'
import TypeNodeEditor from '../components/common/TypeNodeEditor.vue'
import {
  createTypeNode,
  typeNodeFromSample,
  typeNodeFromValueType,
  valueTypeFromTypeNode,
} from '../components/common/type-node'
import { API_METHOD_OPTIONS } from '../apis/api-model'
import { createApi, getApiInProject, removeApi, updateApi } from '../apis/api-store'
import { requestDefaultsOf } from '../apis/api-config'
import { projectPath } from '../projects/project-path'
import { toastService } from '../toast'

/**
 * 接口编辑器。
 *
 * 三个页签对应接口定义的三件事：怎么发（请求侧）、回来长什么样（样本与结果类型）、
 * 现在通不通（调试）。调试用的是**表单上当前的定义**而不是已保存的那份——填完地址就能
 * 发一次，看到响应再决定要不要保存，这条顺序是接口管理有没有用的关键。
 *
 * 「用这次响应填充样本与类型」是两者之间的桥：响应结构只有真发一次才知道，拿到之后直接
 * 反推成补全用的类型，省掉手抄一遍字段。
 */

const route = useRoute()
const router = useRouter()
const projectId = String(route.params.projectId)
const apiId = typeof route.params.apiId === 'string' ? route.params.apiId : undefined

/** 已存在的定义；`apis/new` 没有 apiId，有 apiId 却取不到就是真不存在 */
const existing = apiId === undefined ? undefined : getApiInProject(apiId, projectId)
const missing = apiId !== undefined && existing === undefined

const draft = reactive<ApiDraft>(existing ? draftFromApi(existing) : createApiDraft())
const resultDraft = ref<TypeNodeDraft>(
  existing
    ? typeNodeFromValueType('', existing.resultType ?? { kind: 'unknown' }, existing.sample)
    : createTypeNode('', 'unknown'),
)

const tab = ref<'define' | 'result' | 'debug'>('define')
const pendingDelete = ref(false)
/** 只有点过保存之后才把校验文案显示出来：空表单第一格还没填就报错只是噪声 */
const saveFailed = ref(false)

/**
 * 结果类型。
 *
 * 类型编辑器没被填过时不写这个字段：补全仍然能按样本推导，多写一个 `{ kind: 'unknown' }`
 * 只是让每条定义的 diff 都多一屏噪声。
 */
const resultType = computed<ValueTypeSchema | undefined>(() => {
  const type = valueTypeFromTypeNode(resultDraft.value)

  return type.kind === 'unknown' ? undefined : type
})

const parsed = computed(() => parseApiDraft(draft, resultType.value))

/** 表单当前定义中能用于发请求的部分；不合法时为 null，调试面板据此说明原因 */
const requestSpec = computed(() => parsed.value.input ?? null)

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
    if (apiId === undefined) {
      const created = createApi(input, projectId)
      // 新建后把 URL 换成真实 id：留在 apis/new 上再点一次保存就是第二条重复接口
      void router.replace(projectPath(projectId, `apis/${created.id}/edit`))
      toastService.show(`接口「${created.name}」已登记`, 'success')
      saveFailed.value = false

      return
    }

    const saved = updateApi(apiId, input)
    toastService.show(`接口「${saved.name}」已保存`, 'success')
    saveFailed.value = false
  } catch (cause) {
    saveFailed.value = true
    toastService.show(messageOf(cause), 'error')
  }
}

/** 删除走两道：第一次点击进入待确认态，第二次才真的删 */
function askDelete(): void {
  if (!pendingDelete.value) {
    pendingDelete.value = true

    return
  }

  remove()
}

function remove(): void {
  if (apiId === undefined) return

  try {
    removeApi(apiId)
    pendingDelete.value = false
    toastService.show('接口已删除', 'success')
    void router.push(projectPath(projectId, 'apis'))
  } catch (cause) {
    pendingDelete.value = false
    toastService.show(messageOf(cause), 'error')
  }
}

/** 响应 → 样本与类型：结构只有真发一次才知道，拿到就直接反推，省掉手抄字段 */
function captureSample(body: unknown): void {
  draft.sampleText = formatJsonValue(body)
  resultDraft.value = typeNodeFromSample('', body)
  tab.value = 'result'
  toastService.show('已用这次响应填充样本与结果类型', 'success')
}
</script>

<template>
  <main v-if="missing" class="lc-api-edit">
    <div class="lc-api-edit__missing">
      <span class="lc-api-edit__missing-title">接口不存在</span>
      <span>它可能已被删除，或链接里的接口 id 不属于当前项目。</span>
      <RouterLink class="lc-api-edit__back" :to="projectPath(projectId, 'apis')"
        >返回接口列表</RouterLink
      >
    </div>
  </main>

  <main v-else class="lc-api-edit">
    <header class="lc-api-edit__head">
      <div class="lc-api-edit__heading">
        <RouterLink class="lc-api-edit__crumb" :to="projectPath(projectId, 'apis')"
          >接口管理</RouterLink
        >
        <h1 class="lc-api-edit__title">
          {{ apiId === undefined ? '登记新接口' : draft.name || '未命名接口' }}
        </h1>
      </div>

      <div class="lc-api-edit__actions">
        <button
          v-if="apiId !== undefined"
          type="button"
          class="lc-api-edit__danger"
          :class="{ 'is-confirm': pendingDelete }"
          @click="askDelete"
        >
          {{ pendingDelete ? '再次点击确认删除' : '删除' }}
        </button>
        <button type="button" class="lc-api-edit__save" @click="save">保存</button>
      </div>
    </header>

    <nav class="lc-api-edit__tabs" role="tablist" aria-label="接口定义分节">
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'define'"
        class="lc-api-edit__tab"
        :class="{ 'is-active': tab === 'define' }"
        @click="tab = 'define'"
      >
        请求定义
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'result'"
        class="lc-api-edit__tab"
        :class="{ 'is-active': tab === 'result' }"
        @click="tab = 'result'"
      >
        响应与类型
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'debug'"
        class="lc-api-edit__tab"
        :class="{ 'is-active': tab === 'debug' }"
        @click="tab = 'debug'"
      >
        调试
      </button>
    </nav>

    <section v-show="tab === 'define'" class="lc-api-edit__pane">
      <div class="lc-api-edit__field lc-api-edit__field--wide">
        <label class="lc-api-edit__label" for="lc-api-name">接口名称</label>
        <input
          id="lc-api-name"
          v-model="draft.name"
          class="lc-api-edit__input"
          placeholder="用户列表"
        />
      </div>

      <div class="lc-api-edit__field">
        <label class="lc-api-edit__label" for="lc-api-group">分组</label>
        <input
          id="lc-api-group"
          v-model="draft.group"
          class="lc-api-edit__input"
          placeholder="列表按分组折叠，留空即未分组"
        />
      </div>

      <div class="lc-api-edit__field lc-api-edit__field--wide">
        <label class="lc-api-edit__label" for="lc-api-desc">说明</label>
        <input
          id="lc-api-desc"
          v-model="draft.description"
          class="lc-api-edit__input"
          placeholder="给后来的人：这个接口取什么、有什么坑"
        />
      </div>

      <div class="lc-api-edit__field lc-api-edit__field--request">
        <span class="lc-api-edit__label">请求</span>
        <select id="lc-api-method" v-model="draft.method" class="lc-api-edit__method">
          <option
            v-for="option in API_METHOD_OPTIONS"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <input
          id="lc-api-path"
          v-model="draft.path"
          class="lc-api-edit__input lc-api-edit__input--path"
          placeholder="/users 或 https://api.test/users"
        />
      </div>
      <p class="lc-api-edit__note">
        相对路径会拼上项目请求前缀（在接口列表页顶部设置）；已经写成绝对地址的不拼。
      </p>

      <ApiKeyValueRows
        :rows="draft.headers"
        label="请求头"
        hint="空键的行不会发送"
        key-placeholder="Header-Name"
        value-placeholder="值"
      />

      <ApiKeyValueRows
        :rows="draft.params"
        label="查询参数"
        hint="拼在地址后面，同名时后者胜出"
        key-placeholder="page"
        value-placeholder="1"
      />

      <div class="lc-api-edit__field lc-api-edit__field--wide">
        <label class="lc-api-edit__label" for="lc-api-body">请求体（JSON）</label>
        <textarea
          id="lc-api-body"
          v-model="draft.bodyText"
          class="lc-api-edit__textarea"
          rows="8"
          placeholder='{ "name": "Alice" }'
        ></textarea>
      </div>

      <div class="lc-api-edit__options">
        <label class="lc-api-edit__check">
          <input v-model="draft.withCredentials" type="checkbox" />
          跨域携带凭据
        </label>
        <label class="lc-api-edit__inline" for="lc-api-responsetype">
          响应格式
          <select
            id="lc-api-responsetype"
            v-model="draft.responseType"
            class="lc-api-edit__select"
          >
            <option value="json">json</option>
            <option value="text">text</option>
            <option value="blob">blob</option>
          </select>
        </label>
      </div>
    </section>

    <section v-show="tab === 'result'" class="lc-api-edit__pane">
      <div class="lc-api-edit__field lc-api-edit__field--wide">
        <label class="lc-api-edit__label" for="lc-api-sample">响应样本（JSON）</label>
        <textarea
          id="lc-api-sample"
          v-model="draft.sampleText"
          class="lc-api-edit__textarea"
          rows="10"
          placeholder="样本只服务设计期补全，运行时不会当成数据"
        ></textarea>
      </div>

      <div class="lc-api-edit__field lc-api-edit__field--wide">
        <span class="lc-api-edit__label">结果类型</span>
        <p class="lc-api-edit__note">
          声明之后，页面表达式里
          <code>data.绑定名</code> 才能补全出字段路径；不声明时按样本推导。
        </p>
        <TypeNodeEditor :node="resultDraft" />
      </div>
    </section>

    <section v-show="tab === 'debug'" class="lc-api-edit__pane">
      <ApiDebugPanel
        :spec="requestSpec"
        :defaults="requestDefaultsOf(projectId)"
        @capture="captureSample"
      />
    </section>

    <p v-if="saveFailed && parsed.error" class="lc-api-edit__error">{{ parsed.error }}</p>
  </main>
</template>

<style scoped>
.lc-api-edit {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 16px;
  overflow: auto;
  padding: 24px 36px 40px;
}

.lc-api-edit__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.lc-api-edit__heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.lc-api-edit__crumb,
.lc-api-edit__back {
  color: var(--lc-accent-bright);
  font-size: 12px;
  text-decoration: none;
}

.lc-api-edit__title {
  margin: 0;
  color: var(--lc-text);
  font-size: 18px;
  font-weight: 600;
}

.lc-api-edit__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lc-api-edit__save,
.lc-api-edit__danger {
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text);
  font-size: 12px;
  cursor: pointer;
}

.lc-api-edit__save {
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-api-edit__danger.is-confirm {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-api-edit__tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-api-edit__tab {
  padding: 6px 12px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--lc-radius-sm) var(--lc-radius-sm) 0 0;
  background: none;
  color: var(--lc-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.lc-api-edit__tab.is-active {
  border-color: var(--lc-border);
  background: var(--lc-surface-sunken);
  color: var(--lc-accent-bright);
}

.lc-api-edit__pane {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.lc-api-edit__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lc-api-edit__field--wide {
  max-width: 640px;
}

.lc-api-edit__field--request {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.lc-api-edit__label {
  color: var(--lc-text);
  font-size: 12px;
  font-weight: 600;
}

.lc-api-edit__input,
.lc-api-edit__textarea,
.lc-api-edit__select,
.lc-api-edit__method {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
}

.lc-api-edit__input--path {
  flex: 1;
  min-width: 0;
}

.lc-api-edit__textarea {
  height: auto;
  min-height: 120px;
  padding: 8px;
  line-height: 1.6;
  resize: vertical;
}

.lc-api-edit__input:focus-visible,
.lc-api-edit__textarea:focus-visible,
.lc-api-edit__select:focus-visible,
.lc-api-edit__method:focus-visible {
  outline: 2px solid var(--lc-accent);
  outline-offset: 1px;
}

.lc-api-edit__note {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-api-edit__note code {
  color: var(--lc-text-secondary);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
}

.lc-api-edit__options {
  display: flex;
  align-items: center;
  gap: 18px;
}

.lc-api-edit__check,
.lc-api-edit__inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--lc-text-secondary);
  font-size: 12px;
}

.lc-api-edit__error {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 11px;
}

.lc-api-edit__missing {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  color: var(--lc-text-secondary);
  font-size: 12px;
}

.lc-api-edit__missing-title {
  color: var(--lc-text);
  font-size: 16px;
  font-weight: 600;
}
</style>
