<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import type { ExpressionEngine, FunctionSchema } from '@lc/schema'
import { isBuiltinFunction, isValidFunctionName } from '@lc/expression'
import type { FunctionDraft } from '../../functions/function-draft'
import { parseParams, schemaFromDraft } from '../../functions/function-draft'

const props = withDefaults(
  defineProps<{
    /** 初始草稿；组件按挂载时的值拷贝一份，切换条目请用 key 重建 */
    initial: FunctionDraft
    /** 用于校验函数体语法；与运行时注册使用同一个引擎 */
    engine: ExpressionEngine
    /** 当前作用域内已占用的函数名（不含正在编辑的这一条） */
    takenNames: readonly string[]
    /** 提交按钮文案 */
    submitLabel?: string
  }>(),
  { submitLabel: '保存' },
)

const emit = defineEmits<{
  (event: 'submit', value: FunctionSchema): void
  (event: 'cancel'): void
}>()

interface DraftErrors {
  name?: string
  params?: string
  body?: string
}

const draft = reactive<FunctionDraft>({ ...props.initial })
const errors = reactive<DraftErrors>({})
const nameInput = ref<HTMLInputElement | null>(null)

// 从列表切到表单时原名输入焦点已经随按钮卸载，这里把焦点接回第一个字段
onMounted(() => nameInput.value?.focus())

function clearError(field: keyof DraftErrors): void {
  errors[field] = undefined
}

/**
 * 提交前校验。
 *
 * 名字规则与注册表共用同一份实现；函数体交给引擎编译，
 * 保证「编辑器放行」与「运行时可用」之间不会出现两套判定。
 */
function validate(): boolean {
  errors.name = undefined
  errors.params = undefined
  errors.body = undefined

  const name = draft.name.trim()
  if (name === '') {
    errors.name = '请填写函数名'
  } else if (!isValidFunctionName(name)) {
    errors.name = '函数名需以文字、下划线或 $ 开头，且不能是 null / true 等字面量'
  } else if (isBuiltinFunction(name)) {
    errors.name = `「${name}」是内置函数，请换一个名字`
  } else if (props.takenNames.includes(name)) {
    errors.name = `「${name}」已被其他函数占用`
  }

  const seen = new Set<string>()
  for (const param of parseParams(draft.paramsText)) {
    if (!isValidFunctionName(param)) {
      errors.params = `形参「${param}」不是合法标识符`
      break
    }
    if (seen.has(param)) {
      errors.params = `形参「${param}」重复`
      break
    }
    seen.add(param)
  }

  const body = draft.body.trim()
  if (body === '') {
    errors.body = '请填写函数体表达式'
  } else {
    try {
      props.engine.compile(body)
    } catch (error) {
      errors.body = error instanceof Error ? error.message : String(error)
    }
  }

  return !errors.name && !errors.params && !errors.body
}

function onSubmit(): void {
  if (!validate()) return
  emit('submit', schemaFromDraft(draft))
}
</script>

<template>
  <form class="lc-function-form" @submit.prevent="onSubmit">
    <label class="lc-function-form__field">
      <span class="lc-function-form__label">
        函数名
        <em aria-hidden="true">*</em>
      </span>
      <input
        ref="nameInput"
        v-model="draft.name"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="如 progress"
        @input="clearError('name')"
      />
      <span class="lc-function-form__hint"
        >表达式中按此名调用，如 {{ draft.name || 'fn' }}(...)</span
      >
      <span v-if="errors.name" class="lc-function-form__error" role="alert">{{
        errors.name
      }}</span>
    </label>

    <label class="lc-function-form__field">
      <span class="lc-function-form__label">标题</span>
      <input
        v-model="draft.title"
        type="text"
        autocomplete="off"
        placeholder="展示用，可留空"
      />
    </label>

    <label class="lc-function-form__field">
      <span class="lc-function-form__label">形参</span>
      <input
        v-model="draft.paramsText"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="逗号分隔，如 list, prefix；无参可留空"
        @input="clearError('params')"
      />
      <span v-if="errors.params" class="lc-function-form__error" role="alert">
        {{ errors.params }}
      </span>
    </label>

    <label class="lc-function-form__field">
      <span class="lc-function-form__label">
        函数体
        <em aria-hidden="true">*</em>
      </span>
      <textarea
        v-model="draft.body"
        rows="5"
        spellcheck="false"
        placeholder="如 list.filter(t => t.done).length + ' / ' + list.length"
        @input="clearError('body')"
      />
      <span class="lc-function-form__hint">
        纯表达式，只能访问形参与已注册函数；不要写副作用逻辑。
      </span>
      <span v-if="errors.body" class="lc-function-form__error" role="alert">{{
        errors.body
      }}</span>
    </label>

    <label class="lc-function-form__field">
      <span class="lc-function-form__label">说明</span>
      <textarea
        v-model="draft.description"
        rows="2"
        placeholder="这个函数解决什么问题，可留空"
      />
    </label>

    <footer class="lc-function-form__actions">
      <button type="button" class="lc-function-form__button" @click="emit('cancel')">
        取消
      </button>
      <button type="submit" class="lc-function-form__button lc-function-form__button--primary">
        {{ submitLabel }}
      </button>
    </footer>
  </form>
</template>

<style scoped>
.lc-function-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lc-function-form__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.lc-function-form__label {
  color: var(--lc-text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.lc-function-form__label em {
  margin-left: 2px;
  color: var(--lc-danger);
  font-style: normal;
}

.lc-function-form__field input,
.lc-function-form__field textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--lc-border);
  border-radius: 7px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
}

.lc-function-form__field textarea {
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  resize: vertical;
}

.lc-function-form__field input:focus,
.lc-function-form__field textarea:focus {
  border-color: var(--lc-accent);
  outline: 1px solid var(--lc-accent);
}

.lc-function-form__hint {
  color: var(--lc-text-muted);
  font-size: 10px;
  line-height: 1.45;
}

.lc-function-form__error {
  color: var(--lc-danger);
  font-size: 10px;
  line-height: 1.45;
}

.lc-function-form__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 2px;
}

.lc-function-form__button {
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--lc-border);
  border-radius: 7px;
  background: rgba(10, 30, 61, 0.6);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.lc-function-form__button:hover {
  border-color: var(--lc-border-strong);
  background: var(--lc-accent-soft);
}

.lc-function-form__button--primary {
  border-color: rgba(55, 182, 255, 0.55);
  background: linear-gradient(135deg, var(--lc-accent), var(--lc-accent-bright));
  color: #04101f;
  font-weight: 600;
}

.lc-function-form__button--primary:hover {
  border-color: var(--lc-accent-bright);
  background: linear-gradient(135deg, var(--lc-accent-bright), var(--lc-accent-bright));
}

@media (prefers-reduced-motion: reduce) {
  .lc-function-form__button {
    transition: none;
  }
}
</style>
