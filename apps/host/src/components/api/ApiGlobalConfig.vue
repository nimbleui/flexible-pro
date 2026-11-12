<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { HttpService } from '@lc/contracts'
import type { RequestEnvironment } from '@lc/schema'
import { useAppContext } from '@lc/vue'
import ToggleSwitch from '../common/ToggleSwitch.vue'
import ApiConfigDialog from './ApiConfigDialog.vue'
import type { EnvironmentInput } from '../../apis/api-config-model'
import {
  activeEnvironmentOf,
  environmentsOf,
  saveEnvironment,
  setActiveEnvironment,
} from '../../apis/api-config'
import { pushRequestDefaults } from '../../apis/api-load'
import { toastService } from '../../toast'

/**
 * 全局配置卡片：当前项目请求环境的摘要 + 快捷开关。
 *
 * 四栏对应环境的四件事：凭据（Token）、域名、响应头登记、其它策略。卡片只读多写少——
 * 布尔开关与「设为当前」就地生效，完整编辑（环境增删、默认头、凭据来源）收进
 * 「编辑配置」弹框，每个「添加 / ⋯」入口都打开它并聚焦到对应环境。
 *
 * 页签切换的是**预览哪套环境**，不等于生效：生效环境带「当前」标记，预览非生效环境时
 * 出现「设为当前」。这与编辑面板「编辑哪套 / 哪套生效是两件事」的口径一致。
 */

const props = defineProps<{
  /** 环境归属的项目 id */
  projectId: string
}>()

const app = useAppContext()

const environments = computed<readonly RequestEnvironment[]>(() =>
  environmentsOf(props.projectId),
)
const activeEnv = computed(() => activeEnvironmentOf(props.projectId))

/** 卡片当前预览的环境 id；缺省跟着生效环境走 */
const previewEnvId = ref<string>(activeEnv.value.id)

const previewEnv = computed<RequestEnvironment>(
  () => environments.value.find((env) => env.id === previewEnvId.value) ?? activeEnv.value,
)
const isPreviewActive = computed(() => previewEnv.value.id === activeEnv.value.id)

// 环境被删或外部切换后，预览目标可能已不存在：回落到生效环境，不停在悬空 id 上
watch(
  environments,
  (list) => {
    if (!list.some((env) => env.id === previewEnvId.value)) {
      previewEnvId.value = activeEnv.value.id
    }
  },
  { immediate: true },
)

const tokenOn = computed(() => previewEnv.value.auth !== undefined)
const tokenParamName = computed(
  () => previewEnv.value.auth?.headerName?.trim() || 'Authorization',
)
const responseHeaderRows = computed(() =>
  Object.entries(previewEnv.value.responseHeaders ?? {}),
)

const dialogOpen = ref(false)
const dialogFocusEnv = ref<string | undefined>(undefined)

function openConfig(envId?: string): void {
  dialogFocusEnv.value = envId ?? previewEnv.value.id
  dialogOpen.value = true
}

/**
 * 生效配置变了之后：丢掉缓存凭据并把新默认值推给已打开的文档。
 *
 * 与编辑面板同一动作：继续送上一个环境的 token 比请求直接失败更难被发现。
 */
function refreshActive(reason: string): void {
  app.get<HttpService>('http')?.dropTokens()
  pushRequestDefaults(app.workspace, props.projectId)
  toastService.show(reason, 'success')
}

/**
 * 就地改预览环境的一个字段。
 *
 * `saveEnvironment` 是整组替换而非补丁，所以先把预览环境的现有字段全量带上再覆盖目标项，
 * 否则快捷开关会把没碰过的默认头、凭据一起抹掉。
 */
function patchPreview(patch: Partial<EnvironmentInput>, reason: string): void {
  const env = previewEnv.value
  try {
    saveEnvironment(props.projectId, {
      id: env.id,
      name: env.name,
      baseUrl: env.baseUrl,
      headers: env.headers,
      params: env.params,
      responseHeaders: env.responseHeaders,
      withCredentials: env.withCredentials,
      autoRetry: env.autoRetry,
      requestLogging: env.requestLogging,
      auth: env.auth,
      ...patch,
    })

    if (isPreviewActive.value) refreshActive(reason)
    else toastService.show(reason, 'success')
  } catch (cause) {
    toastService.show(cause instanceof Error ? cause.message : String(cause), 'error')
  }
}

function toggleToken(): void {
  // 关闭即移除凭据来源；开启需要选登录接口与 token 路径，交给弹框补全
  if (tokenOn.value) patchPreview({ auth: undefined }, '已关闭凭据注入')
  else openConfig()
}

function toggleFlag(
  key: 'withCredentials' | 'autoRetry' | 'requestLogging',
  label: string,
): void {
  // autoRetry 缺省为 true，其余缺省为 false：先按各自缺省读当前值再取反
  const current =
    key === 'autoRetry' ? previewEnv.value.autoRetry !== false : previewEnv.value[key] === true
  const patch: Partial<EnvironmentInput> = {}
  patch[key] = !current

  patchPreview(patch, `${label}已${!current ? '开启' : '关闭'}`)
}

function addEnvironment(): void {
  try {
    const created = saveEnvironment(props.projectId, {
      name: `环境 ${environments.value.length + 1}`,
    })
    previewEnvId.value = created.id
    openConfig(created.id)
    toastService.show(`已新建「${created.name}」，填好域名后设为当前才会生效`, 'success')
  } catch (cause) {
    toastService.show(cause instanceof Error ? cause.message : String(cause), 'error')
  }
}

function makeActive(): void {
  try {
    const env = setActiveEnvironment(props.projectId, previewEnv.value.id)
    refreshActive(`已切换到「${env.name}」，已打开页面的接口数据会重新取一次`)
  } catch (cause) {
    toastService.show(cause instanceof Error ? cause.message : String(cause), 'error')
  }
}
</script>

<template>
  <section class="lc-gconf" aria-label="全局配置">
    <div class="lc-gconf__head">
      <span class="lc-gconf__gear" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          />
        </svg>
      </span>
      <span class="lc-gconf__title">全局配置</span>
      <span class="lc-gconf__hint">配置全局的请求参数、环境域名等信息，供所有接口使用</span>

      <button v-if="!isPreviewActive" type="button" class="lc-gconf__ghost" @click="makeActive">
        设为当前
      </button>
      <button type="button" class="lc-gconf__edit" @click="openConfig()">
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        编辑配置
      </button>
    </div>

    <div class="lc-gconf__grid">
      <section class="lc-gconf__col" aria-label="Token 配置">
        <div class="lc-gconf__col-head">
          <h3 class="lc-gconf__col-title">Token 配置</h3>
          <ToggleSwitch
            :model-value="tokenOn"
            label="启用凭据注入"
            @update:model-value="toggleToken"
          />
        </div>

        <label class="lc-gconf__field">
          <span class="lc-gconf__label">参数名：</span>
          <input
            class="lc-gconf__input"
            :value="tokenOn ? tokenParamName : 'token'"
            readonly
            :title="tokenOn ? '在编辑配置中修改注入头名' : '开启后在编辑配置中选择登录接口'"
            @click="openConfig()"
          />
        </label>
        <label class="lc-gconf__field">
          <span class="lc-gconf__label">注入位置：</span>
          <input
            class="lc-gconf__input"
            value="Header"
            readonly
            title="凭据统一注入请求头"
            @click="openConfig()"
          />
        </label>
        <p class="lc-gconf__note">
          {{ tokenOn ? '请求前自动取票并注入请求头' : '开启后选择登录接口，自动取票注入' }}
        </p>
      </section>

      <section class="lc-gconf__col" aria-label="环境域名配置">
        <div class="lc-gconf__col-head">
          <h3 class="lc-gconf__col-title">环境域名配置</h3>
          <span class="lc-gconf__info" title="相对路径的接口按生效环境的域名拼接；绝对地址不拼"
            >ⓘ</span
          >
        </div>

        <div class="lc-gconf__tabs" role="tablist" aria-label="预览环境">
          <button
            v-for="env in environments.length > 0 ? environments : [activeEnv]"
            :key="env.id"
            type="button"
            role="tab"
            :aria-selected="env.id === previewEnv.id"
            class="lc-gconf__tab"
            :class="{ 'is-active': env.id === previewEnv.id }"
            @click="previewEnvId = env.id"
          >
            {{ env.name }}
            <span
              v-if="env.id === activeEnv.id"
              class="lc-gconf__tab-dot"
              title="当前生效"
            ></span>
          </button>
          <button
            type="button"
            class="lc-gconf__tab lc-gconf__tab--add"
            aria-label="新增环境"
            @click="addEnvironment"
          >
            +
          </button>
        </div>

        <div class="lc-gconf__domains">
          <div v-if="previewEnv.baseUrl" class="lc-gconf__domain">
            <span class="lc-gconf__domain-dot" aria-hidden="true"></span>
            <code class="lc-gconf__domain-url">{{ previewEnv.baseUrl }}</code>
            <button
              type="button"
              class="lc-gconf__dots"
              :aria-label="`编辑 ${previewEnv.name} 的域名`"
              @click="openConfig()"
            >
              ⋯
            </button>
          </div>
          <div v-else class="lc-gconf__domain lc-gconf__domain--empty">
            <span class="lc-gconf__domain-dot" aria-hidden="true"></span>
            <span class="lc-gconf__domain-empty">未配置域名 · 同源相对路径</span>
            <button
              type="button"
              class="lc-gconf__dots"
              aria-label="配置域名"
              @click="openConfig()"
            >
              ⋯
            </button>
          </div>
        </div>

        <button type="button" class="lc-gconf__add" @click="openConfig()">+ 添加域名</button>
      </section>

      <section class="lc-gconf__col" aria-label="响应头配置">
        <div class="lc-gconf__col-head">
          <h3 class="lc-gconf__col-title">响应头配置</h3>
          <span
            class="lc-gconf__info"
            title="登记网关应返回的响应头（如 CORS），随环境导出；浏览器不据此修改真实响应"
            >ⓘ</span
          >
        </div>

        <table class="lc-gconf__table">
          <thead>
            <tr>
              <th>参数名</th>
              <th>值</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[key, value] in responseHeaderRows" :key="key">
              <td>
                <code>{{ key }}</code>
              </td>
              <td>
                <code>{{ value }}</code>
              </td>
            </tr>
            <tr v-if="responseHeaderRows.length === 0">
              <td colspan="2" class="lc-gconf__table-empty">暂无登记</td>
            </tr>
          </tbody>
        </table>

        <button type="button" class="lc-gconf__add" @click="openConfig()">+ 添加响应头</button>
      </section>

      <section class="lc-gconf__col" aria-label="其他配置">
        <div class="lc-gconf__col-head">
          <h3 class="lc-gconf__col-title">其他配置</h3>
        </div>

        <label class="lc-gconf__check">
          <input
            type="checkbox"
            :checked="previewEnv.withCredentials === true"
            @change="toggleFlag('withCredentials', '携带凭证')"
          />
          携带凭证 (withCredentials)
        </label>
        <label class="lc-gconf__check">
          <input
            type="checkbox"
            :checked="previewEnv.autoRetry !== false"
            @change="toggleFlag('autoRetry', '自动重试')"
          />
          自动重试
        </label>
        <label class="lc-gconf__check">
          <input
            type="checkbox"
            :checked="previewEnv.requestLogging === true"
            @change="toggleFlag('requestLogging', '请求日志')"
          />
          开启请求日志
        </label>
        <p class="lc-gconf__note">自动重试：401 时重取凭据并重发一次</p>
      </section>
    </div>

    <ApiConfigDialog
      :open="dialogOpen"
      :project-id="projectId"
      :focus-env-id="dialogFocusEnv"
      @close="dialogOpen = false"
    />
  </section>
</template>

<style scoped>
.lc-gconf {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 14px;
  padding: 14px 18px 16px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(165deg, var(--lc-surface), var(--lc-surface-sunken));
}

.lc-gconf__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.lc-gconf__gear {
  display: inline-flex;
  color: var(--lc-accent-bright);
}

.lc-gconf__title {
  color: var(--lc-text);
  font-size: 14px;
  font-weight: 650;
}

.lc-gconf__hint {
  color: var(--lc-text-muted);
  font-size: 12px;
}

.lc-gconf__edit,
.lc-gconf__ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color var(--lc-motion-fast) var(--lc-ease-out),
    color var(--lc-motion-fast) var(--lc-ease-out);
}

.lc-gconf__edit {
  margin-left: auto;
}

.lc-gconf__edit:hover,
.lc-gconf__ghost:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-gconf__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
}

.lc-gconf__col {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 0 18px;
  border-left: 1px solid var(--lc-hairline);
}

.lc-gconf__col:first-child {
  padding-left: 0;
  border-left: none;
}

.lc-gconf__col:last-child {
  padding-right: 0;
}

.lc-gconf__col-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lc-gconf__col-title {
  margin: 0;
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-gconf__info {
  color: var(--lc-text-muted);
  font-size: 12px;
  cursor: help;
}

.lc-gconf__field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lc-gconf__label {
  flex: none;
  width: 64px;
  color: var(--lc-text-secondary);
  font-size: 12px;
}

.lc-gconf__input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
  cursor: pointer;
}

.lc-gconf__note {
  margin: auto 0 0;
  color: var(--lc-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.lc-gconf__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.lc-gconf__tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--lc-radius-sm);
  background: none;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    background-color var(--lc-motion-fast) var(--lc-ease-out),
    color var(--lc-motion-fast) var(--lc-ease-out);
}

.lc-gconf__tab:hover {
  color: var(--lc-text);
}

.lc-gconf__tab.is-active {
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
  font-weight: 600;
}

.lc-gconf__tab--add {
  border: 1px dashed var(--lc-border);
  color: var(--lc-text-muted);
}

.lc-gconf__tab-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--lc-success);
  box-shadow: 0 0 6px var(--lc-success);
}

.lc-gconf__domains {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lc-gconf__domain {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.lc-gconf__domain-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--lc-accent-bright);
  box-shadow: 0 0 8px var(--lc-glow);
}

.lc-gconf__domain--empty .lc-gconf__domain-dot {
  background: var(--lc-text-muted);
  box-shadow: none;
}

.lc-gconf__domain-url {
  overflow: hidden;
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-gconf__domain-empty {
  color: var(--lc-text-muted);
  font-size: 12px;
}

.lc-gconf__dots {
  flex: none;
  margin-left: auto;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--lc-text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.lc-gconf__dots:hover {
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-gconf__add {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: var(--lc-accent-bright);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-gconf__add:hover {
  text-decoration: underline;
}

.lc-gconf__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.lc-gconf__table th {
  padding: 5px 8px;
  border: 1px solid var(--lc-hairline);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-muted);
  font-weight: 500;
  text-align: left;
}

.lc-gconf__table td {
  padding: 5px 8px;
  border: 1px solid var(--lc-hairline);
  color: var(--lc-text-secondary);
}

.lc-gconf__table code {
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  word-break: break-all;
}

.lc-gconf__table-empty {
  color: var(--lc-text-muted);
  text-align: center;
}

.lc-gconf__check {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--lc-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.lc-gconf__check input {
  width: 15px;
  height: 15px;
  accent-color: var(--lc-accent);
  cursor: pointer;
}

.lc-gconf :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (max-width: 1200px) {
  .lc-gconf__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px 0;
  }

  .lc-gconf__col:nth-child(3) {
    padding-left: 0;
    border-left: none;
  }
}

@media (max-width: 760px) {
  .lc-gconf__grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .lc-gconf__col {
    padding: 0;
    border-left: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-gconf__edit,
  .lc-gconf__ghost,
  .lc-gconf__tab {
    transition: none;
  }
}
</style>
