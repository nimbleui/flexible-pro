<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ExpressionEngine, FunctionSchema } from '@lc/schema'
import { useAppContext } from '@lc/vue'
import FunctionEditorForm from '../components/functions/FunctionEditorForm.vue'
import type { FunctionDraft } from '../functions/function-draft'
import { EMPTY_FUNCTION_DRAFT, draftFromSchema } from '../functions/function-draft'
import { globalFunctions, saveGlobalFunction } from '../functions/global-functions'

const ctx = useAppContext()
const engine = ctx.require<ExpressionEngine>('expression')
const route = useRoute()
const router = useRouter()

const functionId = computed(() =>
  typeof route.params.functionId === 'string' ? route.params.functionId : undefined,
)

const existing = computed(() =>
  functionId.value === undefined
    ? undefined
    : globalFunctions.value.find((item) => item.id === functionId.value),
)

/** 带上 id 却找不到条目：多半是删掉后从历史链接回来 */
const isMissing = computed(() => functionId.value !== undefined && existing.value === undefined)

const initialDraft = computed<FunctionDraft>(() =>
  existing.value ? draftFromSchema(existing.value) : { ...EMPTY_FUNCTION_DRAFT },
)

const takenNames = computed<readonly string[]>(() =>
  globalFunctions.value.filter((item) => item.id !== functionId.value).map((item) => item.name),
)

const saveError = ref('')

function submit(schema: FunctionSchema): void {
  const body = typeof schema.body === 'string' ? schema.body : schema.body.raw

  try {
    saveGlobalFunction({
      id: functionId.value,
      name: schema.name,
      title: schema.title,
      params: schema.params,
      body,
      description: schema.description,
    })
    void router.push('/functions')
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <main class="lc-function-edit">
    <header class="lc-function-edit__head">
      <RouterLink class="lc-function-edit__back" to="/functions">← 返回函数列表</RouterLink>
      <h1 class="lc-function-edit__title">
        {{ functionId === undefined ? '新建全局函数' : '编辑全局函数' }}
      </h1>
      <p class="lc-function-edit__hint">
        保存后立即注册到表达式引擎，所有页面都可调用；页面级函数请在画布中通过「自定义函数」维护。
      </p>
    </header>

    <div v-if="isMissing" class="lc-function-edit__missing">
      <span class="lc-function-edit__missing-title">函数不存在</span>
      <span>它可能已被删除，或链接中的 id 不正确。</span>
      <RouterLink class="lc-function-edit__back" to="/functions">返回列表</RouterLink>
    </div>

    <section v-else class="lc-function-edit__panel">
      <p v-if="saveError" class="lc-function-edit__error" role="alert">{{ saveError }}</p>

      <!-- key 跟随路由：新建与编辑互切时保证表单重新从对应初始值开始 -->
      <FunctionEditorForm
        :key="functionId ?? 'new'"
        :initial="initialDraft"
        :engine="engine"
        :taken-names="takenNames"
        :submit-label="functionId === undefined ? '创建函数' : '保存修改'"
        @submit="submit"
        @cancel="router.push('/functions')"
      />
    </section>
  </main>
</template>

<style scoped>
.lc-function-edit {
  flex: 1;
  min-height: 0;
  padding: 32px 36px;
  overflow: auto;
}

.lc-function-edit__head {
  max-width: 760px;
  margin-bottom: 20px;
}

.lc-function-edit__back {
  display: inline-flex;
  align-items: center;
  color: var(--lc-text-secondary);
  font-size: 12px;
  text-decoration: none;
}

.lc-function-edit__back:hover {
  color: var(--lc-accent-bright);
}

.lc-function-edit__title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0 6px;
  color: var(--lc-text);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.4px;
}

.lc-function-edit__title::before {
  content: '';
  width: 3px;
  height: 18px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--lc-accent-bright), var(--lc-accent));
  box-shadow: 0 0 10px var(--lc-glow);
}

.lc-function-edit__hint {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.lc-function-edit__panel {
  max-width: 760px;
  padding: 20px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(150deg, rgba(10, 30, 61, 0.85), rgba(7, 21, 40, 0.65));
  box-shadow: 0 10px 30px rgba(0, 6, 18, 0.35);
}

.lc-function-edit__error {
  margin: 0 0 12px;
  padding: 8px 10px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 12px;
  line-height: 1.5;
}

.lc-function-edit__missing {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  max-width: 760px;
  padding: 28px 24px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: rgba(6, 17, 33, 0.5);
  color: var(--lc-text-secondary);
  font-size: 13px;
}

.lc-function-edit__missing-title {
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-function-edit :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}
</style>
