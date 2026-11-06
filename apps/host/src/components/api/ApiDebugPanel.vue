<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { formatJsonValue } from '@lc/shared'
import type { ApiRequestFields, RequestDefaults } from '@lc/schema'
import type { ApiRequestResult } from '../../apis/api-request'
import { previewRequestUrl, sendApiRequest } from '../../apis/api-request'

defineOptions({ name: 'LcApiDebugPanel' })

const props = defineProps<{
  /** 草稿解析出的请求侧字段；表单还缺名称或路径时父级传 null，面板只说明不发请求 */
  spec: ApiRequestFields | null
  /** 当前生效环境的请求默认值；域名与默认头据此合进请求 */
  defaults?: RequestDefaults
}>()

const emit = defineEmits<{
  /** 把这次响应的内容写回接口定义（样本与结果类型） */
  (event: 'capture', body: unknown): void
}>()

const sending = ref(false)
const result = ref<ApiRequestResult | null>(null)
let controller: AbortController | undefined

const previewUrl = computed(() =>
  props.spec === null ? '' : previewRequestUrl(props.spec, props.defaults),
)

/** 响应体的展示文本：解析成功给格式化 JSON，失败给原始文本 */
const bodyText = computed(() => {
  const current = result.value
  if (!current) return ''
  if (current.rawText !== undefined) return current.rawText

  return formatJsonValue(current.body)
})

const canCapture = computed(
  () => result.value !== null && result.value.ok && result.value.body !== undefined,
)

async function send(): Promise<void> {
  if (props.spec === null || sending.value) return

  controller = new AbortController()
  sending.value = true
  try {
    result.value = await sendApiRequest(props.spec, props.defaults, {
      signal: controller.signal,
    })
  } finally {
    sending.value = false
    controller = undefined
  }
}

function cancel(): void {
  controller?.abort()
}

// 离开页面时中止在途请求：结果已经没人读了，留着连接只会拖住一次无谓的响应
onBeforeUnmount(() => {
  controller?.abort()
})
</script>

<template>
  <section class="lc-api-debug">
    <div class="lc-api-debug__target">
      <code class="lc-api-debug__method">{{ props.spec?.method ?? 'GET' }}</code>
      <code class="lc-api-debug__url">{{ previewUrl || '填写请求路径后显示完整地址' }}</code>
    </div>

    <p v-if="props.spec === null" class="lc-api-debug__blocked">
      名称与请求路径填完才能发送：调试用的是表单上当前的定义，不必先保存。
    </p>

    <div class="lc-api-debug__actions">
      <button
        type="button"
        class="lc-api-debug__send"
        :disabled="props.spec === null || sending"
        @click="void send()"
      >
        {{ sending ? '发送中…' : '发送请求' }}
      </button>
      <button v-if="sending" type="button" class="lc-api-debug__cancel" @click="cancel">
        取消
      </button>
      <button
        v-if="canCapture"
        type="button"
        class="lc-api-debug__capture"
        @click="emit('capture', result?.body)"
      >
        用这次响应填充样本与类型
      </button>
    </div>

    <div v-if="result" class="lc-api-debug__result">
      <div class="lc-api-debug__summary">
        <span class="lc-api-debug__status" :class="result.ok ? 'is-ok' : 'is-fail'">
          {{ result.status === 0 ? '未发出' : result.status }}
          {{ result.statusText }}
        </span>
        <span class="lc-api-debug__time">{{ result.durationMs }} ms</span>
        <code class="lc-api-debug__sent">{{ result.url }}</code>
      </div>

      <p v-if="result.error" class="lc-api-debug__error">{{ result.error }}</p>

      <dl v-if="Object.keys(result.headers).length > 0" class="lc-api-debug__headers">
        <template v-for="(value, key) in result.headers" :key="key">
          <dt>{{ key }}</dt>
          <dd>{{ value }}</dd>
        </template>
      </dl>

      <pre v-if="bodyText" class="lc-api-debug__body">{{ bodyText }}</pre>
    </div>
  </section>
</template>

<style scoped>
.lc-api-debug {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lc-api-debug__target {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
}

.lc-api-debug__method {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
  font-size: 11px;
  font-weight: 600;
}

.lc-api-debug__url {
  overflow: hidden;
  color: var(--lc-text-secondary);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-api-debug__blocked {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-api-debug__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lc-api-debug__send,
.lc-api-debug__cancel,
.lc-api-debug__capture {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text);
  font-size: 12px;
  cursor: pointer;
}

.lc-api-debug__send {
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-api-debug__send:disabled {
  border-color: var(--lc-border);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-muted);
  cursor: not-allowed;
}

.lc-api-debug__capture {
  border-style: dashed;
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-api-debug__result {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lc-api-debug__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.lc-api-debug__status {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--lc-border);
  font-size: 11px;
}

.lc-api-debug__status.is-ok {
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
}

.lc-api-debug__status.is-fail {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-api-debug__time {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-api-debug__sent {
  overflow: hidden;
  max-width: 100%;
  color: var(--lc-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-api-debug__error {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 11px;
}

.lc-api-debug__headers {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 0;
  font-size: 11px;
}

.lc-api-debug__headers dt {
  color: var(--lc-text-muted);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
}

.lc-api-debug__headers dd {
  margin: 0;
  color: var(--lc-text-secondary);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  word-break: break-all;
}

.lc-api-debug__body {
  max-height: 320px;
  margin: 0;
  padding: 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
