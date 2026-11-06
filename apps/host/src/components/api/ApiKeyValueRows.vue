<script setup lang="ts">
import type { ApiKeyValueRow } from './api-draft'

defineOptions({ name: 'LcApiKeyValueRows' })

const props = withDefaults(
  defineProps<{
    /** 行数组；本组件原地增删改，与结构化类型编辑器同一做法：父级持有同一份响应式对象 */
    rows: ApiKeyValueRow[]
    /** 字段标题，如「请求头」 */
    label: string
    /** 标题右侧的补充说明 */
    hint?: string
    keyPlaceholder?: string
    valuePlaceholder?: string
    /**
     * 判断某一行是否敏感（如 `Authorization`）。
     *
     * 按键名而不是整块切换：默认头里既有 token 也有 `X-App-Version`，全掩码会让人连
     * 正常值都要点开才能确认。
     */
    masked?: (key: string) => boolean
    /** 父级的「显示敏感值」开关；关闭时敏感行按密码框渲染 */
    reveal?: boolean
  }>(),
  {
    hint: '',
    keyPlaceholder: '名称',
    valuePlaceholder: '值',
    masked: undefined,
    reveal: false,
  },
)

function isMasked(key: string): boolean {
  return props.masked?.(key) === true && !props.reveal
}

function addRow(): void {
  props.rows.push({ key: '', value: '' })
}

function removeRow(index: number): void {
  props.rows.splice(index, 1)

  // 删空后补一行空行：否则这块区域会缩成只剩标题，看不出这里还能填
  if (props.rows.length === 0) addRow()
}
</script>

<template>
  <div class="lc-api-rows">
    <div class="lc-api-rows__head">
      <span class="lc-api-rows__label">{{ label }}</span>
      <span v-if="hint" class="lc-api-rows__hint">{{ hint }}</span>
    </div>

    <div v-for="(row, index) in props.rows" :key="index" class="lc-api-rows__row">
      <input
        v-model="row.key"
        class="lc-api-rows__input"
        :placeholder="keyPlaceholder"
        :aria-label="`${label}名称`"
      />
      <input
        v-model="row.value"
        class="lc-api-rows__input lc-api-rows__input--value"
        :type="isMasked(row.key) ? 'password' : 'text'"
        :placeholder="valuePlaceholder"
        :aria-label="`${label}值`"
      />
      <button
        type="button"
        class="lc-api-rows__remove"
        :aria-label="`删除这一行${label}`"
        @click="removeRow(index)"
      >
        ×
      </button>
    </div>

    <button type="button" class="lc-api-rows__add" @click="addRow">+ 添加一行</button>
  </div>
</template>

<style scoped>
.lc-api-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lc-api-rows__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.lc-api-rows__label {
  color: var(--lc-text);
  font-size: 12px;
  font-weight: 600;
}

.lc-api-rows__hint {
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-api-rows__row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lc-api-rows__input {
  flex: 1 1 42%;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 12px;
}

.lc-api-rows__input--value {
  flex: 1 1 58%;
}

.lc-api-rows__input:focus-visible {
  outline: 2px solid var(--lc-accent);
  outline-offset: 1px;
}

.lc-api-rows__remove {
  flex: none;
  width: 24px;
  height: 24px;
  border: 1px solid transparent;
  border-radius: var(--lc-radius-sm);
  background: none;
  color: var(--lc-text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.lc-api-rows__remove:hover {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-api-rows__add {
  align-self: flex-start;
  padding: 2px 8px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: none;
  color: var(--lc-text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.lc-api-rows__add:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}
</style>
