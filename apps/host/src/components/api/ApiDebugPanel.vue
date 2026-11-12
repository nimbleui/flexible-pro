<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { ApiRequestFields, RequestEnvironment } from '@lc/schema'
import { apiToRestConfig, mergeRequestDefaults } from '@lc/schema'
import { formatJsonValue, parseJsonDraft } from '@lc/shared'
import type { ApiKeyValueRow } from './api-draft'
import { mapToRows, rowsToMap } from './api-draft'
import { highlightJsonLines, plainTextLines } from './json-highlight'
import type { ApiRequestResult } from '../../apis/api-request'
import { previewRequestUrl, sendApiRequest } from '../../apis/api-request'
import { activeEnvironmentOf, environmentsOf } from '../../apis/api-config'
import { toRequestDefaults } from '../../apis/api-config-model'
import { toastService } from '../../toast'

defineOptions({ name: 'LcApiDebugPanel' })

/**
 * 接口调试台。
 *
 * 三段对应一次调试的三步：选类型（当前平台只有 REST 真正可发）、配请求（环境 + 方法地址 +
 * 参数 / 头 / 体的**测试值**）、看响应（结果 / 请求信息 / 响应头）。测试值是一份独立沙箱，
 * 初始镜像当前定义，改动只用于这次发送、不落进接口定义——这样填一个临时 userId 试一次，
 * 不会把定义里的默认值改掉。一旦动过沙箱就停止镜像，避免把用户填的测试值冲掉。
 *
 * 响应体来自任意外部服务，高亮前先转义（见 json-highlight），复制与「填充到样本」都只读
 * 这次真实响应。
 */

const props = defineProps<{
  /** 草稿解析出的请求侧字段；表单还缺名称或路径时父级传 null，面板只说明不发请求 */
  spec: ApiRequestFields | null
  /** 归属项目 id；调试环境从该项目的环境表里选 */
  projectId: string
}>()

const emit = defineEmits<{
  /** 把这次响应的内容写回接口定义（样本与结果类型） */
  (event: 'capture', body: unknown): void
}>()

const sending = ref(false)
const result = ref<ApiRequestResult | null>(null)
let controller: AbortController | undefined

const environments = computed<readonly RequestEnvironment[]>(() =>
  environmentsOf(props.projectId),
)
const activeEnv = computed(() => activeEnvironmentOf(props.projectId))
const debugEnvId = ref<string>(activeEnv.value.id)
const selectedEnv = computed<RequestEnvironment>(
  () => environments.value.find((env) => env.id === debugEnvId.value) ?? activeEnv.value,
)
const defaults = computed(() => toRequestDefaults(selectedEnv.value))

// 环境被删后调试目标可能悬空：回落到生效环境
watch(
  environments,
  (list) => {
    if (!list.some((env) => env.id === debugEnvId.value)) debugEnvId.value = activeEnv.value.id
  },
  { immediate: true },
)

const reqTab = ref<'params' | 'query' | 'headers' | 'body'>('params')
const resTab = ref<'result' | 'request' | 'headers'>('result')
const REQ_TABS = [
  { id: 'params', label: 'Params' },
  { id: 'query', label: 'Query' },
  { id: 'headers', label: 'Headers' },
  { id: 'body', label: '请求体' },
] as const
const RES_TABS = [
  { id: 'result', label: '响应结果' },
  { id: 'request', label: '请求信息' },
  { id: 'headers', label: '响应头' },
] as const

/** 测试值沙箱：初始镜像定义，动过之后（touched）不再被定义改动覆盖 */
const sandbox = reactive({
  params: [] as ApiKeyValueRow[],
  headers: [] as ApiKeyValueRow[],
  bodyText: '',
})
const touched = ref(false)
const copied = ref(false)

function initSandbox(spec: ApiRequestFields | null): void {
  sandbox.params = mapToRows(spec?.params)
  sandbox.headers = mapToRows(spec?.headers)
  sandbox.bodyText = formatJsonValue(spec?.body)
}

watch(
  () => props.spec,
  (spec) => {
    if (!touched.value) initSandbox(spec)
  },
  { immediate: true },
)

function markTouched(): void {
  touched.value = true
}

const bodyParse = computed(() => parseJsonDraft(sandbox.bodyText))

/** 这次发送真正用的请求侧字段：定义的方法/路径 + 沙箱里的测试值 */
const effectiveSpec = computed<ApiRequestFields | null>(() => {
  if (props.spec === null) return null

  return {
    ...props.spec,
    params: rowsToMap(sandbox.params),
    headers: rowsToMap(sandbox.headers),
    body: bodyParse.value.ok ? bodyParse.value.value : undefined,
  }
})

const previewUrl = computed(() =>
  effectiveSpec.value === null ? '' : previewRequestUrl(effectiveSpec.value, defaults.value),
)

const queryString = computed(() => {
  const entries = sandbox.params
    .filter((row) => row.key.trim() !== '')
    .map((row) => [row.key.trim(), row.value])

  return entries.length === 0 ? '' : new URLSearchParams(entries).toString()
})

/** 合并环境默认值后的请求配置，供「请求信息」展示实际发出的头与体 */
const mergedRequest = computed(() =>
  effectiveSpec.value === null
    ? null
    : mergeRequestDefaults(apiToRestConfig(effectiveSpec.value), defaults.value),
)

const responseLines = computed(() => {
  const current = result.value
  if (!current) return []
  if (current.rawText !== undefined) return plainTextLines(current.rawText)
  return highlightJsonLines(current.body)
})

const responseText = computed(() => {
  const current = result.value
  if (!current) return ''
  return current.rawText !== undefined ? current.rawText : formatJsonValue(current.body)
})

const canCapture = computed(
  () => result.value !== null && result.value.ok && result.value.body !== undefined,
)

function addParam(): void {
  sandbox.params.push({ key: '', value: '' })
  markTouched()
}

function removeParam(index: number): void {
  sandbox.params.splice(index, 1)
  if (sandbox.params.length === 0) sandbox.params.push({ key: '', value: '' })
  markTouched()
}

function addHeader(): void {
  sandbox.headers.push({ key: '', value: '' })
  markTouched()
}

function removeHeader(index: number): void {
  sandbox.headers.splice(index, 1)
  if (sandbox.headers.length === 0) sandbox.headers.push({ key: '', value: '' })
  markTouched()
}

async function send(): Promise<void> {
  if (effectiveSpec.value === null || sending.value) return
  if (!bodyParse.value.ok) {
    toastService.show(`请求体：${bodyParse.value.error}`, 'error')
    return
  }

  controller = new AbortController()
  sending.value = true
  try {
    result.value = await sendApiRequest(effectiveSpec.value, defaults.value, {
      signal: controller.signal,
    })
    resTab.value = 'result'
  } finally {
    sending.value = false
    controller = undefined
  }
}

function cancel(): void {
  controller?.abort()
}

async function copy(): Promise<void> {
  if (responseText.value === '') return
  try {
    await navigator.clipboard.writeText(responseText.value)
    copied.value = true
    toastService.show('已复制响应内容', 'success')
    setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    toastService.show('复制失败：浏览器未授予剪贴板权限', 'error')
  }
}

function capture(): void {
  if (canCapture.value) emit('capture', result.value?.body)
}

// 离开页面时中止在途请求：结果已经没人读了，留着连接只会拖住一次无谓的响应
onBeforeUnmount(() => {
  controller?.abort()
})
</script>

<template>
  <section class="lc-debug">
    <div class="lc-debug__card">
      <h3 class="lc-debug__title">接口类型</h3>
      <div class="lc-debug__types">
        <button type="button" class="lc-debug__type is-active" aria-pressed="true">
          <span class="lc-debug__type-icon lc-debug__type-icon--rest" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
              />
              <path d="m3.3 7 8.7 5 8.7-5" />
              <path d="M12 22V12" />
            </svg>
          </span>
          <span class="lc-debug__type-name">REST API</span>
          <span class="lc-debug__type-desc">标准的 HTTP 接口</span>
        </button>

        <button type="button" class="lc-debug__type" disabled title="GraphQL 调试暂未支持">
          <span class="lc-debug__type-icon lc-debug__type-icon--graphql" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3z" />
              <path d="M12 3v18" />
              <path d="m4 7.5 16 9" />
              <path d="m20 7.5-16 9" />
            </svg>
          </span>
          <span class="lc-debug__type-name">GraphQL</span>
          <span class="lc-debug__type-desc">基于 GraphQL 协议</span>
          <span class="lc-debug__soon">规划中</span>
        </button>

        <button type="button" class="lc-debug__type" disabled title="WebSocket 调试暂未支持">
          <span class="lc-debug__type-icon lc-debug__type-icon--ws" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M5 12.55a11 11 0 0 1 14.08 0" />
              <path d="M1.42 9a16 16 0 0 1 21.16 0" />
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
              <line x1="12" y1="20" x2="12.01" y2="20" />
            </svg>
          </span>
          <span class="lc-debug__type-name">WebSocket</span>
          <span class="lc-debug__type-desc">实时双向通信</span>
          <span class="lc-debug__soon">规划中</span>
        </button>
      </div>
    </div>

    <div class="lc-debug__card">
      <div class="lc-debug__head">
        <h3 class="lc-debug__title">接口调试</h3>
        <div class="lc-debug__head-actions">
          <select v-model="debugEnvId" class="lc-debug__env" aria-label="调试环境">
            <option
              v-for="env in environments.length > 0 ? environments : [activeEnv]"
              :key="env.id"
              :value="env.id"
            >
              {{ env.name }}{{ env.id === activeEnv.id ? '（当前）' : '' }}
            </option>
          </select>
          <button
            type="button"
            class="lc-debug__send"
            :disabled="effectiveSpec === null || sending"
            @click="void send()"
          >
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
            {{ sending ? '发送中…' : '发送请求' }}
          </button>
          <button v-if="sending" type="button" class="lc-debug__cancel" @click="cancel">
            取消
          </button>
        </div>
      </div>

      <div class="lc-debug__target">
        <span class="lc-debug__method" :data-method="spec?.method ?? 'GET'">{{
          spec?.method ?? 'GET'
        }}</span>
        <input
          class="lc-debug__url"
          :value="previewUrl"
          readonly
          placeholder="填写请求路径后显示完整地址"
          aria-label="请求地址"
        />
      </div>

      <div class="lc-debug__tabs" role="tablist" aria-label="请求内容">
        <button
          v-for="item in REQ_TABS"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="reqTab === item.id"
          class="lc-debug__tab"
          :class="{ 'is-active': reqTab === item.id }"
          @click="reqTab = item.id"
        >
          {{ item.label }}
        </button>
      </div>

      <div v-show="reqTab === 'params'" class="lc-debug__pane">
        <table class="lc-debug__table">
          <thead>
            <tr>
              <th>参数名</th>
              <th>值</th>
              <th class="lc-debug__op"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in sandbox.params" :key="index">
              <td>
                <input
                  v-model="row.key"
                  class="lc-debug__cell"
                  placeholder="userId"
                  aria-label="参数名"
                  @input="markTouched"
                />
              </td>
              <td>
                <input
                  v-model="row.value"
                  class="lc-debug__cell"
                  placeholder="123"
                  aria-label="参数值"
                  @input="markTouched"
                />
              </td>
              <td class="lc-debug__op">
                <button
                  type="button"
                  class="lc-debug__trash"
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
        <button type="button" class="lc-debug__add" @click="addParam">+ 添加参数</button>
      </div>

      <div v-show="reqTab === 'query'" class="lc-debug__pane">
        <p class="lc-debug__hint">按当前参数拼出的查询串与完整地址（域名取所选环境）：</p>
        <code class="lc-debug__query">{{ queryString || '（无查询参数）' }}</code>
        <code class="lc-debug__query-url">{{
          previewUrl || '填写请求路径后显示完整地址'
        }}</code>
      </div>

      <div v-show="reqTab === 'headers'" class="lc-debug__pane">
        <table class="lc-debug__table">
          <thead>
            <tr>
              <th>参数名</th>
              <th>值</th>
              <th class="lc-debug__op"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in sandbox.headers" :key="index">
              <td>
                <input
                  v-model="row.key"
                  class="lc-debug__cell"
                  placeholder="Content-Type"
                  aria-label="请求头名称"
                  @input="markTouched"
                />
              </td>
              <td>
                <input
                  v-model="row.value"
                  class="lc-debug__cell"
                  placeholder="application/json"
                  aria-label="请求头值"
                  @input="markTouched"
                />
              </td>
              <td class="lc-debug__op">
                <button
                  type="button"
                  class="lc-debug__trash"
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
        <button type="button" class="lc-debug__add" @click="addHeader">+ 添加请求头</button>
      </div>

      <div v-show="reqTab === 'body'" class="lc-debug__pane">
        <textarea
          v-model="sandbox.bodyText"
          class="lc-debug__body"
          rows="6"
          placeholder='{ "name": "Alice" }'
          aria-label="请求体 JSON"
          @input="markTouched"
        ></textarea>
        <p v-if="!bodyParse.ok" class="lc-debug__error">{{ bodyParse.error }}</p>
        <p v-else class="lc-debug__hint">GET / HEAD 请求不会携带请求体。</p>
      </div>

      <p v-if="effectiveSpec === null" class="lc-debug__blocked">
        名称与请求路径填完才能发送：调试用的是表单上当前的定义，不必先保存。
      </p>
    </div>

    <div class="lc-debug__card">
      <div class="lc-debug__tabs lc-debug__tabs--res" role="tablist" aria-label="响应内容">
        <button
          v-for="item in RES_TABS"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="resTab === item.id"
          class="lc-debug__tab"
          :class="{ 'is-active': resTab === item.id }"
          @click="resTab = item.id"
        >
          {{ item.label }}
        </button>
      </div>

      <div v-show="resTab === 'result'" class="lc-debug__pane">
        <template v-if="result">
          <div class="lc-debug__status">
            <span
              class="lc-debug__dot"
              :class="result.ok ? 'is-ok' : 'is-fail'"
              aria-hidden="true"
            ></span>
            <span class="lc-debug__code" :class="result.ok ? 'is-ok' : 'is-fail'">
              {{ result.status === 0 ? '未发出' : result.status }}
            </span>
            <span class="lc-debug__status-text" :class="result.ok ? 'is-ok' : 'is-fail'">
              {{ result.statusText || (result.ok ? 'OK' : '失败') }}
            </span>
            <span class="lc-debug__time">{{ result.durationMs }}ms</span>
            <div class="lc-debug__status-actions">
              <button
                v-if="canCapture"
                type="button"
                class="lc-debug__capture"
                @click="capture"
              >
                填充到样本
              </button>
              <button type="button" class="lc-debug__copy" @click="void copy()">
                {{ copied ? '已复制' : '复制' }}
              </button>
            </div>
          </div>

          <p v-if="result.error" class="lc-debug__error">{{ result.error }}</p>

          <div v-if="responseLines.length > 0" class="lc-debug__codeblock">
            <div
              v-for="(line, index) in responseLines"
              :key="index"
              class="lc-debug__code-line"
            >
              <span class="lc-debug__ln" aria-hidden="true">{{ index + 1 }}</span>
              <span class="lc-debug__lc" v-html="line"></span>
            </div>
          </div>
          <p v-else class="lc-debug__hint">（无响应体）</p>
        </template>
        <div v-else class="lc-debug__empty">
          <span class="lc-debug__empty-title">尚未发送请求</span>
          <span>配好上方请求后点击「发送请求」，这里会显示状态码、耗时与响应体。</span>
        </div>
      </div>

      <div v-show="resTab === 'request'" class="lc-debug__pane">
        <template v-if="result && mergedRequest">
          <dl class="lc-debug__meta">
            <dt>方法</dt>
            <dd>{{ spec?.method }}</dd>
            <dt>地址</dt>
            <dd class="lc-debug__mono">{{ result.url }}</dd>
            <template v-if="result.authHeader">
              <dt>凭据头</dt>
              <dd>{{ result.authHeader }}（运行时注入）</dd>
            </template>
          </dl>

          <div class="lc-debug__sub">请求头</div>
          <table v-if="mergedRequest.headers" class="lc-debug__table">
            <tbody>
              <tr v-for="(value, key) in mergedRequest.headers" :key="key">
                <td>
                  <code>{{ key }}</code>
                </td>
                <td>
                  <code>{{ value }}</code>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="lc-debug__hint">（无请求头）</p>

          <div class="lc-debug__sub">请求体</div>
          <pre class="lc-debug__pre">{{ formatJsonValue(mergedRequest.body) || '（无）' }}</pre>
        </template>
        <div v-else class="lc-debug__empty">
          <span class="lc-debug__empty-title">尚未发送请求</span>
          <span>发送后这里显示实际发出的方法、地址、请求头与请求体。</span>
        </div>
      </div>

      <div v-show="resTab === 'headers'" class="lc-debug__pane">
        <table v-if="result && Object.keys(result.headers).length > 0" class="lc-debug__table">
          <thead>
            <tr>
              <th>参数名</th>
              <th>值</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(value, key) in result.headers" :key="key">
              <td>
                <code>{{ key }}</code>
              </td>
              <td>
                <code>{{ value }}</code>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="lc-debug__empty">
          <span class="lc-debug__empty-title">{{
            result ? '（无响应头）' : '尚未发送请求'
          }}</span>
          <span v-if="!result">发送后这里显示服务端返回的响应头。</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.lc-debug {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.lc-debug__card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px 16px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(165deg, var(--lc-surface), var(--lc-surface-sunken));
}

.lc-debug__title {
  margin: 0;
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 650;
}

.lc-debug__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.lc-debug__head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 接口类型卡片 */
.lc-debug__types {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.lc-debug__type {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 12px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  cursor: pointer;
  transition:
    border-color var(--lc-motion-fast) var(--lc-ease-out),
    box-shadow var(--lc-motion-fast) var(--lc-ease-out),
    background-color var(--lc-motion-fast) var(--lc-ease-out);
}

.lc-debug__type.is-active {
  border-color: var(--lc-accent);
  background: linear-gradient(160deg, var(--lc-accent-soft), var(--lc-surface-sunken));
  box-shadow:
    0 0 0 1px var(--lc-accent-soft),
    0 0 20px var(--lc-glow-soft);
}

.lc-debug__type:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.lc-debug__type-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
}

.lc-debug__type-icon--rest {
  color: var(--lc-accent-bright);
}

.lc-debug__type-icon--graphql {
  color: var(--lc-accent-2-bright);
}

.lc-debug__type-icon--ws {
  color: var(--lc-success);
}

.lc-debug__type-name {
  font-size: 13px;
  font-weight: 650;
}

.lc-debug__type-desc {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-debug__soon {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 1px 6px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-pill);
  color: var(--lc-text-muted);
  font-size: 10px;
}

/* 环境选择 + 发送 */
.lc-debug__env {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-debug__env option {
  background: var(--lc-surface);
  color: var(--lc-text);
}

.lc-debug__send {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--lc-accent);
  border-radius: var(--lc-radius-sm);
  background: linear-gradient(
    135deg,
    var(--lc-accent-bright),
    var(--lc-accent) 55%,
    var(--lc-accent-2)
  );
  box-shadow: 0 0 14px var(--lc-glow-soft);
  color: var(--lc-on-accent);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: box-shadow var(--lc-motion-fast) var(--lc-ease-out);
}

.lc-debug__send:hover:not(:disabled) {
  box-shadow: 0 0 20px var(--lc-glow);
}

.lc-debug__send:disabled {
  border-color: var(--lc-border);
  background: var(--lc-surface-sunken);
  box-shadow: none;
  color: var(--lc-text-muted);
  cursor: not-allowed;
}

.lc-debug__cancel {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: none;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

/* 方法 + 地址 */
.lc-debug__target {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.lc-debug__method {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: 56px;
  padding: 0 10px;
  border-radius: var(--lc-radius-sm);
  background: var(--lc-accent);
  color: var(--lc-on-accent);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
  font-weight: 700;
}

.lc-debug__method[data-method='POST'] {
  background: var(--lc-success);
}

.lc-debug__method[data-method='PUT'] {
  background: var(--lc-warning);
}

.lc-debug__method[data-method='DELETE'] {
  background: var(--lc-danger);
}

.lc-debug__method[data-method='PATCH'] {
  background: var(--lc-accent-2);
}

.lc-debug__url {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
}

/* 页签 */
.lc-debug__tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-debug__tabs--res {
  margin: -2px 0 0;
}

.lc-debug__tab {
  position: relative;
  padding: 7px 12px;
  border: none;
  background: none;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-debug__tab.is-active {
  color: var(--lc-accent-bright);
  font-weight: 600;
}

.lc-debug__tab.is-active::after {
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

.lc-debug__pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 参数 / 头表格 */
.lc-debug__table {
  width: 100%;
  border-collapse: collapse;
}

.lc-debug__table th {
  padding: 6px 10px;
  border: 1px solid var(--lc-hairline);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-muted);
  font-size: 11px;
  font-weight: 500;
  text-align: left;
}

.lc-debug__table td {
  padding: 4px 8px;
  border: 1px solid var(--lc-hairline);
  color: var(--lc-text-secondary);
  font-size: 12px;
}

.lc-debug__table code {
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  word-break: break-all;
}

.lc-debug__op {
  width: 44px;
  text-align: center;
}

.lc-debug__cell {
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

.lc-debug__cell:hover {
  border-color: var(--lc-border);
}

.lc-debug__cell:focus {
  border-color: var(--lc-accent);
  background: var(--lc-surface-sunken);
  outline: none;
}

.lc-debug__trash {
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

.lc-debug__trash:hover {
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-debug__add {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: var(--lc-accent-bright);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-debug__add:hover {
  text-decoration: underline;
}

.lc-debug__hint {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.lc-debug__query,
.lc-debug__query-url {
  padding: 8px 10px;
  border: 1px solid var(--lc-hairline);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
  word-break: break-all;
}

.lc-debug__query-url {
  color: var(--lc-accent-bright);
}

.lc-debug__body {
  min-height: 120px;
  padding: 8px 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
}

.lc-debug__body:focus {
  border-color: var(--lc-accent);
  outline: none;
}

.lc-debug__blocked {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-debug__error {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 11px;
}

/* 响应状态行 */
.lc-debug__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.lc-debug__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.lc-debug__dot.is-ok {
  background: var(--lc-success);
  box-shadow: 0 0 8px var(--lc-success);
}

.lc-debug__dot.is-fail {
  background: var(--lc-danger);
  box-shadow: 0 0 8px var(--lc-danger);
}

.lc-debug__code {
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 13px;
  font-weight: 700;
}

.lc-debug__code.is-ok {
  color: var(--lc-success);
}

.lc-debug__code.is-fail {
  color: var(--lc-danger);
}

.lc-debug__status-text {
  font-size: 12px;
  font-weight: 600;
}

.lc-debug__status-text.is-ok {
  color: var(--lc-success);
}

.lc-debug__status-text.is-fail {
  color: var(--lc-danger);
}

.lc-debug__time {
  color: var(--lc-text-muted);
  font-size: 12px;
}

.lc-debug__status-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.lc-debug__capture {
  height: 26px;
  padding: 0 10px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: none;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.lc-debug__capture:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-debug__copy {
  height: 26px;
  padding: 0 14px;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-debug__copy:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

/* 响应体代码块：行号 gutter + 语法高亮 */
.lc-debug__codeblock {
  max-height: 360px;
  padding: 10px 0;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--lc-border-strong) transparent;
}

.lc-debug__codeblock::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.lc-debug__codeblock::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: var(--lc-border-strong);
}

.lc-debug__codeblock::-webkit-scrollbar-thumb:hover {
  background: var(--lc-accent);
}

.lc-debug__code-line {
  display: flex;
  align-items: baseline;
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
  line-height: 1.7;
}

.lc-debug__ln {
  flex: none;
  width: 40px;
  padding-right: 12px;
  color: var(--lc-text-muted);
  text-align: right;
  user-select: none;
}

.lc-debug__lc {
  flex: 1;
  min-width: 0;
  padding-right: 12px;
  color: var(--lc-text-secondary);
  white-space: pre;
}

.lc-debug__lc :deep(.lc-json-key) {
  color: var(--lc-accent-bright);
}

.lc-debug__lc :deep(.lc-json-str) {
  color: var(--lc-warning);
}

.lc-debug__lc :deep(.lc-json-num) {
  color: var(--lc-text);
}

.lc-debug__lc :deep(.lc-json-bool) {
  color: var(--lc-accent-2-bright);
}

.lc-debug__lc :deep(.lc-json-null) {
  color: var(--lc-text-muted);
}

/* 请求信息 / 响应头 */
.lc-debug__meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  margin: 0;
  font-size: 12px;
}

.lc-debug__meta dt {
  color: var(--lc-text-muted);
}

.lc-debug__meta dd {
  margin: 0;
  color: var(--lc-text);
}

.lc-debug__mono {
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  word-break: break-all;
}

.lc-debug__sub {
  margin-top: 4px;
  color: var(--lc-text);
  font-size: 12px;
  font-weight: 600;
}

.lc-debug__pre {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--lc-hairline);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.lc-debug__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 16px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-sm);
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

.lc-debug__empty-title {
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-debug :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (max-width: 760px) {
  .lc-debug__types {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-debug__type,
  .lc-debug__send {
    transition: none;
  }
}
</style>
