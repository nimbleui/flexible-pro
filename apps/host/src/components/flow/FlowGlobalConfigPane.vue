<script setup lang="ts">
import { computed } from 'vue'
import type { JsonDraftResult } from '@lc/shared'
import type { FlowSettings } from '@lc/schema'
import type { FlowEditorHandle } from './composables/use-flow-editor'
import {
  fieldDraftText,
  isTextOrEmpty,
  parseFieldDraft,
  useFlowFieldDraft,
} from './composables/use-flow-field-draft'

const props = defineProps<{
  /** 流程编辑器句柄 */
  editor: FlowEditorHandle
}>()

const flow = computed(() => props.editor.flow.value)

const errorIssues = computed(() => props.editor.blockingIssues.value)

const warningIssues = computed(() =>
  props.editor.issues.value.filter((issue) => issue.severity === 'warning'),
)

const {
  draft: nameText,
  onInput: onNameInput,
  commitDraft: commitName,
} = useFlowFieldDraft({
  display: () => fieldDraftText('text', flow.value?.name),
  parse: (text) => parseFieldDraft('text', text),
  commit: (value) => {
    if (!isTextOrEmpty(value)) return
    props.editor.updateMeta({ name: value ?? '' })
  },
})

const {
  draft: descriptionText,
  onInput: onDescriptionInput,
  commitDraft: commitDescription,
} = useFlowFieldDraft({
  display: () => fieldDraftText('text', flow.value?.description),
  parse: (text) => parseFieldDraft('text', text),
  commit: (value) => {
    if (!isTextOrEmpty(value)) return
    props.editor.updateMeta({ description: value })
  },
})

/**
 * 流程级数字设置。
 *
 * 与节点 config 不同，`FlowSettings` 的两个字段都是必填 number，所以这里不接受
 * 「清空」：留空只回错误，文档保持原值，否则执行器会拿到 undefined 超时。
 */
function useSettingsField(key: keyof FlowSettings) {
  return useFlowFieldDraft({
    display: () => {
      const settings = flow.value?.settings

      return settings ? String(settings[key]) : ''
    },
    parse: (text): JsonDraftResult => {
      const parsed = Number(text.trim())

      return text.trim() !== '' && Number.isFinite(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, error: '请输入有效数字' }
    },
    commit: (value) => {
      if (typeof value !== 'number') return

      // 逐项写而不是拼计算键：计算键会被推成 index signature，Partial 检查随之失效
      if (key === 'timeoutSeconds') props.editor.updateSettings({ timeoutSeconds: value })
      else props.editor.updateSettings({ maxConcurrency: value })
    },
  })
}

const {
  draft: timeoutText,
  error: timeoutError,
  onInput: onTimeoutInput,
  commitDraft: commitTimeout,
} = useSettingsField('timeoutSeconds')

const {
  draft: concurrencyText,
  error: concurrencyError,
  onInput: onConcurrencyInput,
  commitDraft: commitConcurrency,
} = useSettingsField('maxConcurrency')
</script>

<template>
  <div class="lc-flow-inspector__pane">
    <div class="lc-flow-inspector__form">
      <div class="lc-flow-inspector__field">
        <label class="lc-flow-inspector__field-label" for="lc-flow-global-name">
          流程名称
          <em class="lc-flow-inspector__required">*</em>
        </label>
        <input
          id="lc-flow-global-name"
          class="lc-flow-inspector__input"
          type="text"
          :value="nameText"
          placeholder="如：订单审批流程"
          @input="onNameInput"
          @change="commitName"
          @blur="commitName"
        />
      </div>

      <div class="lc-flow-inspector__field">
        <label class="lc-flow-inspector__field-label" for="lc-flow-global-desc">流程说明</label>
        <input
          id="lc-flow-global-desc"
          class="lc-flow-inspector__input"
          type="text"
          :value="descriptionText"
          placeholder="这条流程做什么"
          @input="onDescriptionInput"
          @change="commitDescription"
          @blur="commitDescription"
        />
      </div>

      <div class="lc-flow-inspector__field">
        <label class="lc-flow-inspector__field-label" for="lc-flow-global-timeout">
          超时秒数
          <em class="lc-flow-inspector__required">*</em>
        </label>
        <input
          id="lc-flow-global-timeout"
          class="lc-flow-inspector__input"
          type="number"
          min="1"
          :value="timeoutText"
          @input="onTimeoutInput"
          @change="commitTimeout"
          @blur="commitTimeout"
        />
        <p v-if="timeoutError" class="lc-flow-inspector__field-error">{{ timeoutError }}</p>
      </div>

      <div class="lc-flow-inspector__field">
        <label class="lc-flow-inspector__field-label" for="lc-flow-global-concurrency">
          并发上限
          <em class="lc-flow-inspector__required">*</em>
        </label>
        <input
          id="lc-flow-global-concurrency"
          class="lc-flow-inspector__input"
          type="number"
          min="1"
          :value="concurrencyText"
          @input="onConcurrencyInput"
          @change="commitConcurrency"
          @blur="commitConcurrency"
        />
        <p v-if="concurrencyError" class="lc-flow-inspector__field-error">
          {{ concurrencyError }}
        </p>
      </div>
    </div>

    <section class="lc-flow-inspector__section">
      <h3 class="lc-flow-inspector__section-title">校验结果</h3>

      <p
        v-if="errorIssues.length === 0 && warningIssues.length === 0"
        class="lc-flow-inspector__hint"
      >
        当前图没有发现问题
      </p>

      <div v-else class="lc-flow-inspector__issues">
        <div v-if="errorIssues.length > 0" class="lc-flow-inspector__issue-group">
          <p class="lc-flow-inspector__issue-head is-error">
            阻断问题（{{ errorIssues.length }}）
          </p>
          <ul class="lc-flow-inspector__issue-list">
            <li v-for="(issue, index) in errorIssues" :key="`error-${index}`">
              <span class="lc-flow-inspector__issue-message">{{ issue.message }}</span>
              <code class="lc-flow-inspector__issue-path">{{ issue.path }}</code>
            </li>
          </ul>
        </div>

        <div v-if="warningIssues.length > 0" class="lc-flow-inspector__issue-group">
          <p class="lc-flow-inspector__issue-head is-warning">
            提示（{{ warningIssues.length }}）
          </p>
          <ul class="lc-flow-inspector__issue-list">
            <li v-for="(issue, index) in warningIssues" :key="`warning-${index}`">
              <span class="lc-flow-inspector__issue-message">{{ issue.message }}</span>
              <code class="lc-flow-inspector__issue-path">{{ issue.path }}</code>
            </li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>
