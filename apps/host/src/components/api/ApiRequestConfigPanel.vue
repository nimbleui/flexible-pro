<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { HttpRequestAuth, RequestEnvironment } from '@lc/schema'
import { apiRequestFieldsOf } from '@lc/schema'
import type { HttpService } from '@lc/contracts'
import { useAppContext } from '@lc/vue'
import type { ApiKeyValueRow } from './api-draft'
import { mapToRows, rowsToMap } from './api-draft'
import ApiKeyValueRows from './ApiKeyValueRows.vue'
import { DEFAULT_ENVIRONMENT } from '../../apis/api-config-model'
import { pushRequestDefaults } from '../../apis/api-load'
import { apisOfProject } from '../../apis/api-store'
import {
  activeEnvironmentOf,
  environmentsOf,
  removeEnvironment,
  saveEnvironment,
  setActiveEnvironment,
} from '../../apis/api-config'
import { toastService } from '../../toast'

/**
 * 项目请求环境面板。
 *
 * 域名、默认请求头（token 这类）、默认查询参数与凭据策略都在这里，一次配好、整个项目的
 * REST 取数都吃它。值存在项目侧而不是接口定义里，是为了让 token 不会跟着文档被导出或复制。
 *
 * 「编辑哪套」与「哪套生效」是两件事，所以有两个动作：切换编辑目标只改这个面板，
 * 「设为当前」才会把新的默认值推给已经打开的文档并触发重新取数。
 */

const props = defineProps<{
  /** 环境归属的项目 id */
  projectId: string
  /** 打开时聚焦编辑的环境 id；缺省跟着生效环境走 */
  focusEnvId?: string
}>()

/** 值可能被旁人读到，也可能被误复制进文档：敏感头名按掩码显示 */
const SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'api-key',
]

const app = useAppContext()

const environments = computed<readonly RequestEnvironment[]>(() =>
  environmentsOf(props.projectId),
)
const activeId = computed(() => activeEnvironmentOf(props.projectId).id)

/** 面板当前编辑的环境 id；缺省跟着生效环境走，外部指定时优先 */
const editingId = ref<string>(props.focusEnvId ?? activeId.value)
const revealSecrets = ref(false)
const draft = reactive({
  name: '',
  baseUrl: '',
  withCredentials: false,
  autoRetry: true,
  requestLogging: false,
  headers: [] as ApiKeyValueRow[],
  params: [] as ApiKeyValueRow[],
  responseHeaders: [] as ApiKeyValueRow[],
  /** 凭据来源：登录接口的 id，空串表示「不用凭据」 */
  authApiId: '',
  /** token 在响应里的点路径 */
  authTokenPath: '',
  authHeaderName: '',
  authValueTemplate: '',
})

/** 本项目登记的接口；凭据来源只能从里面选，登录地址才跟着环境拼域名 */
const projectApis = computed(() => apisOfProject(props.projectId))

/**
 * 切换编辑目标时整体重建草稿。
 *
 * 不是「保存后重置」：用户在两套环境间来回看时，未保存的编辑会留在草稿里，看起来像是
 * 已经生效。切目标就重读存储，是让「没保存」这件事只有一种表现。
 */
watch(
  editingId,
  (id) => {
    const env = environments.value.find((item) => item.id === id)
    // 还没配过环境时编辑的是那套隐含的兜底环境：把它的名字预填上，保存即成为正式一条
    draft.name = env?.name ?? (id === DEFAULT_ENVIRONMENT.id ? DEFAULT_ENVIRONMENT.name : '')
    draft.baseUrl = env?.baseUrl ?? ''
    draft.withCredentials = env?.withCredentials === true
    draft.autoRetry = env?.autoRetry !== false
    draft.requestLogging = env?.requestLogging === true
    draft.headers = mapToRows(env?.headers)
    draft.params = mapToRows(env?.params)
    draft.responseHeaders = mapToRows(env?.responseHeaders)
    draft.authApiId = env?.auth?.sourceApiId ?? ''
    draft.authTokenPath = env?.auth?.tokenPath ?? ''
    draft.authHeaderName = env?.auth?.headerName ?? ''
    draft.authValueTemplate = env?.auth?.valueTemplate ?? ''
  },
  { immediate: true },
)

// 外部改动（本面板保存、或另一个视图改了配置）也同步编辑目标，避免停在一个已删除的环境上
watch(activeId, (id) => {
  if (!environments.value.some((env) => env.id === id)) editingId.value = id
})

const isEditingActive = computed(() => editingId.value === activeId.value)

function isSensitive(key: string): boolean {
  return SENSITIVE_HEADERS.includes(key.trim().toLowerCase())
}

function addEnvironment(): void {
  const created = saveEnvironment(props.projectId, {
    name: `环境 ${environments.value.length + 1}`,
  })
  editingId.value = created.id
  toastService.show(`已新建「${created.name}」，填好域名后设为当前才会生效`, 'success')
}

/**
 * 凭据来源草稿 → `HttpRequestAuth`。
 *
 * 没选接口就整块缺省。请求侧字段按**当前定义**拷一份进环境（`apiRequestFieldsOf`），
 * 而不是运行时按 id 回查接口表：环境改一次即生效，已发布版本用的仍是它自己那份副本。
 * 代价是登录接口改了路径之后这里要重新保存一次——面板会把路径显示出来，不至于看不见。
 *
 * @throws 选的接口已被删掉时抛错：留下一个指向不存在接口的凭据，请求只会带着空 token 出门
 */
function authFromDraft(): HttpRequestAuth | undefined {
  if (draft.authApiId === '') return undefined

  const api = projectApis.value.find((item) => item.id === draft.authApiId)
  if (!api) throw new Error('[host] 凭据来源选的接口已不存在，请重新选择')

  return {
    request: apiRequestFieldsOf(api),
    sourceApiId: api.id,
    tokenPath: draft.authTokenPath,
    headerName: draft.authHeaderName,
    valueTemplate: draft.authValueTemplate,
  }
}

/**
 * 生效配置变了之后：丢掉缓存凭据并把新默认值推给已打开的文档。
 *
 * 丢缓存是必须的——继续在业务请求上送出上一个环境的 token，比请求直接失败更难被发现。
 */
function refreshActive(reason: string): void {
  app.get<HttpService>('http')?.dropTokens()
  pushRequestDefaults(app.workspace, props.projectId)
  toastService.show(reason, 'success')
}

function save(): void {
  try {
    const wasActive = isEditingActive.value
    saveEnvironment(props.projectId, {
      id: editingId.value,
      name: draft.name,
      baseUrl: draft.baseUrl,
      headers: rowsToMap(draft.headers),
      params: rowsToMap(draft.params),
      responseHeaders: rowsToMap(draft.responseHeaders),
      withCredentials: draft.withCredentials,
      autoRetry: draft.autoRetry,
      requestLogging: draft.requestLogging,
      auth: authFromDraft(),
    })
    // 动的若是还没启用的环境，就不该让所有已打开的页面重取一遍
    if (wasActive) refreshActive('请求配置已保存，已打开页面的接口数据会重新取一次')
    else toastService.show('请求配置已保存', 'success')
  } catch (cause) {
    toastService.show(cause instanceof Error ? cause.message : String(cause), 'error')
  }
}

function makeActive(): void {
  try {
    const env = setActiveEnvironment(props.projectId, editingId.value)
    refreshActive(`已切换到「${env.name}」，已打开页面的接口数据会重新取一次`)
  } catch (cause) {
    toastService.show(cause instanceof Error ? cause.message : String(cause), 'error')
  }
}

function remove(): void {
  try {
    removeEnvironment(props.projectId, editingId.value)
    editingId.value = activeId.value
    refreshActive('环境已删除')
  } catch (cause) {
    toastService.show(cause instanceof Error ? cause.message : String(cause), 'error')
  }
}

function onPick(event: Event): void {
  const target = event.target as HTMLSelectElement
  editingId.value = target.value
}
</script>

<template>
  <section class="lc-api-config" aria-label="请求配置">
    <div class="lc-api-config__head">
      <h2 class="lc-api-config__title">请求配置</h2>

      <label class="lc-api-config__picker">
        <span>编辑环境</span>
        <select class="lc-api-config__select" :value="editingId" @change="onPick">
          <option v-for="env in environments" :key="env.id" :value="env.id">
            {{ env.name }}{{ env.id === activeId ? '（当前生效）' : '' }}
          </option>
        </select>
      </label>

      <button type="button" class="lc-api-config__ghost" @click="addEnvironment">
        + 新增环境
      </button>
      <button
        v-if="!isEditingActive"
        type="button"
        class="lc-api-config__ghost"
        @click="makeActive"
      >
        设为当前
      </button>
      <button
        v-if="environments.length > 1"
        type="button"
        class="lc-api-config__ghost lc-api-config__ghost--danger"
        @click="remove"
      >
        删除环境
      </button>
    </div>

    <p class="lc-api-config__hint">
      这里只影响相对路径与请求自己没写的字段：接口或页面写过的同名值以它自己为准， token
      也因此不会落进页面文档。
    </p>

    <div class="lc-api-config__grid">
      <label class="lc-api-config__field">
        <span>环境名称</span>
        <input v-model="draft.name" type="text" placeholder="本地 / 测试 / 生产" />
      </label>

      <label class="lc-api-config__field lc-api-config__field--wide">
        <span>域名前缀</span>
        <input
          v-model="draft.baseUrl"
          type="text"
          placeholder="留空即同源相对路径，例如 https://api.test 或 /api"
        />
      </label>
    </div>

    <ApiKeyValueRows
      :rows="draft.headers"
      label="默认请求头"
      hint="同名时不覆盖请求自己写的；敏感值默认掩码"
      key-placeholder="Authorization"
      value-placeholder="Bearer …"
      :masked="isSensitive"
    />

    <ApiKeyValueRows
      :rows="draft.params"
      label="默认查询参数"
      hint="请求没带同名参数时才拼进地址"
      key-placeholder="tenantId"
      value-placeholder="值"
    />

    <ApiKeyValueRows
      :rows="draft.responseHeaders"
      label="响应头（登记）"
      hint="网关应返回的响应头，如 CORS；仅登记随环境导出，浏览器不据此修改真实响应"
      key-placeholder="Access-Control-Allow-Origin"
      value-placeholder="*"
    />

    <div class="lc-api-config__auth">
      <span class="lc-api-config__label">凭据（可选）</span>
      <label class="lc-api-config__field">
        <span>登录接口</span>
        <select v-model="draft.authApiId">
          <option value="">不使用凭据</option>
          <option v-for="api in projectApis" :key="api.id" :value="api.id">
            {{ api.name }}（{{ api.method }} {{ api.path }}）
          </option>
        </select>
      </label>

      <p v-if="draft.authApiId === ''" class="lc-api-config__hint">
        选一条项目接口当登录接口后，取到的值会注入请求头；请求遇到 401 会重取一次并重发一次。
      </p>

      <template v-else>
        <div class="lc-api-config__grid">
          <label class="lc-api-config__field">
            <span>token 路径</span>
            <input v-model="draft.authTokenPath" type="text" placeholder="data.accessToken" />
          </label>
          <label class="lc-api-config__field">
            <span>头名</span>
            <input v-model="draft.authHeaderName" type="text" placeholder="Authorization" />
          </label>
          <label class="lc-api-config__field lc-api-config__field--wide">
            <span>值模板</span>
            <input v-model="draft.authValueTemplate" type="text" placeholder="Bearer {token}" />
          </label>
        </div>
        <p v-if="draft.authTokenPath.trim() === ''" class="lc-api-config__warn">
          填了登录接口就要填 token 路径，否则保存会被拒绝。
        </p>
      </template>
    </div>

    <div class="lc-api-config__foot">
      <label class="lc-api-config__check">
        <input v-model="draft.withCredentials" type="checkbox" />
        跨域请求携带凭据
      </label>
      <label class="lc-api-config__check">
        <input v-model="draft.autoRetry" type="checkbox" />
        401 自动重试
      </label>
      <label class="lc-api-config__check">
        <input v-model="draft.requestLogging" type="checkbox" />
        请求日志
      </label>
      <label class="lc-api-config__check">
        <input v-model="revealSecrets" type="checkbox" />
        显示敏感头的值
      </label>
      <button type="button" class="lc-api-config__save" @click="save">保存该环境</button>
    </div>
  </section>
</template>

<style scoped>
.lc-api-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
}

.lc-api-config__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.lc-api-config__title {
  margin: 0;
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-api-config__picker,
.lc-api-config__field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-api-config__select,
.lc-api-config__field input {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
}

.lc-api-config__field--wide {
  flex: 1;
  min-width: 260px;
}

.lc-api-config__field--wide input {
  flex: 1;
  min-width: 0;
}

.lc-api-config__grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.lc-api-config__hint {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.lc-api-config__auth {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  border: 1px dashed var(--lc-border-strong);
  border-radius: var(--lc-radius-sm);
}

.lc-api-config__label {
  color: var(--lc-text);
  font-size: 12px;
  font-weight: 600;
}

.lc-api-config__warn {
  margin: 0;
  color: var(--lc-warning);
  font-size: 11px;
}

.lc-api-config__field select {
  height: 28px;
  max-width: 320px;
  padding: 0 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text);
  font-size: 12px;
}

.lc-api-config__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}

.lc-api-config__check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-api-config__ghost,
.lc-api-config__save {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: none;
  color: var(--lc-text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.lc-api-config__ghost--danger:hover {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-api-config__save {
  margin-left: auto;
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}
</style>
