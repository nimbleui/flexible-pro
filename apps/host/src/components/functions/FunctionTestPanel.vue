<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type {
  CompiledExpression,
  ExpressionEngine,
  ExpressionScope,
  ValueTypeKind,
} from '@lc/schema'
import { isValidFunctionName, isExpressionError } from '@lc/expression'
import { SYMBOL_KIND_LABELS, symbolKindOf } from '@lc/expression/editor'
import type { TypeNodeDraft } from '../common/type-node'
import { inputTextFromTypeNode, parseTypeInput } from '../common/type-node'

const props = defineProps<{
  /** 与保存后同一份引擎实例：函数之间的互相调用按真实注册结果解析 */
  engine: ExpressionEngine
  /** 函数名；名字合法时试跑会临时注册，函数体内的自调用才解析得到 */
  name: string
  /** 形参节点，决定输入行的类型与初始文本 */
  params: readonly TypeNodeDraft[]
  /** 函数体原文 */
  body: string
}>()

/** 一行试跑输入 */
interface TestRow {
  /** 形参名，也是求值作用域里的键 */
  name: string
  kind: ValueTypeKind
  /** 类型展示文案 */
  kindLabel: string
  /** 对象与数组用多行框，JSON 更好读 */
  multiline: boolean
  text: string
}

/** 一次试跑的展示结果 */
interface TestOutcome {
  ok: boolean
  /** 状态行：成功时给返回值类型与耗时，失败时给失败阶段 */
  status: string
  /** 返回值 JSON，或引擎与输入校验的报错原文 */
  detail: string
}

const rows = reactive<TestRow[]>([])
const outcome = ref<TestOutcome | null>(null)

function buildRow(param: TypeNodeDraft, name: string, previous: string | undefined): TestRow {
  return {
    name,
    kind: param.kind,
    kindLabel: SYMBOL_KIND_LABELS[param.kind],
    multiline: param.kind === 'object' || param.kind === 'array',
    text: previous ?? inputTextFromTypeNode(param),
  }
}

/**
 * 形参增删、改名或换类型时重建输入行。
 *
 * 签名里只有名字与类型：改示例值不重建，避免用户正在调的那一组实参被清空，
 * 需要同步声明时用「用声明重置」。
 */
watch(
  () => props.params.map((param) => `${param.name.trim()}\u0001${param.kind}`).join('\u0002'),
  () => {
    const previous = new Map(rows.map((row) => [row.name, row.text]))
    const next: TestRow[] = []

    for (const param of props.params) {
      const name = param.name.trim()
      if (name !== '') next.push(buildRow(param, name, previous.get(name)))
    }

    rows.splice(0, rows.length, ...next)
  },
  { immediate: true },
)

/** 函数体或实参一变就撤掉上一次结果：挂着旧结论会让人以为眼前这份写法已经验证过 */
watch(
  () => [props.body, ...rows.map((row) => row.text)],
  () => {
    outcome.value = null
  },
)

function rowError(row: TestRow): string | undefined {
  return parseTypeInput(row.kind, row.text).error
}

/** 形参名 → 实参；空文本绑成 undefined，与调用处少传一个实参的效果一致 */
function buildScope(): ExpressionScope {
  const scope: ExpressionScope = {}
  for (const row of rows) scope[row.name] = parseTypeInput(row.kind, row.text).value
  return scope
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value, null, 2) ?? String(value)
}

/**
 * 返回值的类型文案。
 *
 * `symbolKindOf` 把 null / undefined 都归到 `unknown`（那是给补全用的宽松口径），
 * 但状态行写「返回 未知类型」配一个 `null` 会让人以为引擎没算出来。
 */
function resultKind(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return SYMBOL_KIND_LABELS[symbolKindOf(value)]
}

/** 耗时文案：正常表达式都在亚毫秒，保留两位小数只会显示一串 0.00 */
function formatElapsed(ms: number): string {
  return ms < 1 ? '<1ms' : `${ms.toFixed(1)}ms`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 运行错误的展示文案。
 *
 * 名字没填合法时草稿进不了注册表，函数体里的自调用只会得到「既不是已注册函数，也不在作用域里」——
 * 这句引擎原文把原因指向「那个函数不存在」，而真实原因是名字还没填，所以补一行触发条件。
 */
function runFailureDetail(error: unknown, selfRegistered: boolean): string {
  const message = errorMessage(error)
  if (selfRegistered || !isExpressionError(error) || error.kind !== 'unknown-function') {
    return message
  }

  return `${message}\n函数名还没填合法，函数体里的自调用解析不到当前草稿。`
}

/**
 * 用当前草稿跑一次。
 *
 * 走 `compile().evaluate()` 而不是 `engine.evaluate()`：后者吞掉异常返回 undefined，
 * 而试跑必须能区分「结果就是 undefined」与「求值失败」。
 * 草稿按页面层临时注册再立即注销，函数体内调用自己时解析到的才是眼前这份草稿，
 * 注销后注册表回到原样；整个窗口是同步的，画布渲染不会看到中间状态。
 */
function run(): void {
  const body = props.body.trim()
  if (body === '') {
    outcome.value = { ok: false, status: '未运行', detail: '请先填写函数体' }
    return
  }

  const invalid = rows.find((row) => rowError(row) !== undefined)
  if (invalid) {
    outcome.value = {
      ok: false,
      status: '未运行',
      detail: `实参「${invalid.name}」不符合声明类型`,
    }
    return
  }

  let compiled: CompiledExpression
  try {
    compiled = props.engine.compile(body)
  } catch (error) {
    outcome.value = { ok: false, status: '语法错误', detail: errorMessage(error) }
    return
  }

  // 名字还没填合法时不注册：注册必被拒绝，多一条诊断只是噪音
  const declaredName = props.name.trim()
  const selfRegistered = isValidFunctionName(declaredName)
  const registration = selfRegistered
    ? props.engine.functions.register(
        { name: declaredName, params: rows.map((row) => row.name), body },
        'page',
      )
    : { dispose: () => {} }

  try {
    const startedAt = performance.now()
    const value = compiled.evaluate(buildScope())
    const elapsed = performance.now() - startedAt

    outcome.value = {
      ok: true,
      status: `返回 ${resultKind(value)} · ${formatElapsed(elapsed)}`,
      detail: formatValue(value),
    }
  } catch (error) {
    outcome.value = {
      ok: false,
      status: '运行错误',
      detail: runFailureDetail(error, selfRegistered),
    }
  } finally {
    registration.dispose()
  }
}

/** 用声明结构重新填充所有输入行 */
function resetInputs(): void {
  for (const row of rows) {
    const param = props.params.find((item) => item.name.trim() === row.name)
    if (param) row.text = inputTextFromTypeNode(param)
  }
}

function placeholderOf(kind: ValueTypeKind): string {
  if (kind === 'string') return '字符串实参'
  if (kind === 'number') return '如 1'
  if (kind === 'boolean') return 'true / false'
  if (kind === 'array') return '如 [{"id":1}]'
  if (kind === 'object') return '如 {"id":1}'
  return 'JSON 或文本'
}
</script>

<template>
  <section class="lc-function-test">
    <header class="lc-function-test__head">
      <span class="lc-function-test__title">试跑</span>
      <div class="lc-function-test__buttons">
        <button
          v-if="rows.length > 0"
          type="button"
          class="lc-function-test__button"
          @click="resetInputs"
        >
          用声明重置
        </button>
        <button
          type="button"
          class="lc-function-test__button lc-function-test__button--run"
          @click="run"
        >
          运行
        </button>
      </div>
    </header>

    <p v-if="rows.length === 0" class="lc-function-test__note">这个函数没有形参，直接运行。</p>

    <div v-else class="lc-function-test__rows">
      <label v-for="(row, index) in rows" :key="index" class="lc-function-test__row">
        <span class="lc-function-test__param">
          <code>{{ row.name }}</code>
          <em>{{ row.kindLabel }}</em>
        </span>

        <textarea
          v-if="row.multiline"
          v-model="row.text"
          rows="2"
          spellcheck="false"
          :placeholder="placeholderOf(row.kind)"
          @keydown.ctrl.enter.prevent="run"
          @keydown.meta.enter.prevent="run"
        />
        <input
          v-else
          v-model="row.text"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="placeholderOf(row.kind)"
          @keydown.enter.prevent="run"
        />

        <span v-if="rowError(row)" class="lc-function-test__error" role="alert">
          {{ rowError(row) }}
        </span>
      </label>
    </div>

    <div
      v-if="outcome"
      class="lc-function-test__result"
      :class="{ 'lc-function-test__result--fail': !outcome.ok }"
    >
      <span class="lc-function-test__status">{{ outcome.status }}</span>
      <pre class="lc-function-test__value">{{ outcome.detail }}</pre>
    </div>

    <p class="lc-function-test__note">
      按真实引擎执行当前草稿：可调用已注册的全局/页面函数与内置函数，但页面数据不进函数作用域，
      需要作为实参传进来；步数或 20ms 时间预算超限会报运行错误。
    </p>
  </section>
</template>

<style scoped>
.lc-function-test {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--lc-border);
  border-radius: 7px;
  background: rgba(6, 17, 33, 0.5);
}

.lc-function-test__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.lc-function-test__title {
  color: var(--lc-text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.lc-function-test__buttons {
  display: flex;
  gap: 6px;
}

.lc-function-test__button {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.lc-function-test__button:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-function-test__button--run {
  border-color: rgba(55, 182, 255, 0.55);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
  font-weight: 600;
}

.lc-function-test__button--run:hover {
  border-color: var(--lc-accent-bright);
}

.lc-function-test__rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lc-function-test__row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.lc-function-test__param {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 10px;
}

.lc-function-test__param code {
  color: var(--lc-accent-bright);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
}

.lc-function-test__param em {
  color: var(--lc-text-muted);
  font-style: normal;
}

.lc-function-test__row input,
.lc-function-test__row textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  line-height: 1.5;
}

.lc-function-test__row input {
  height: 26px;
  padding: 0 8px;
}

.lc-function-test__row textarea {
  resize: vertical;
}

.lc-function-test__row input:focus,
.lc-function-test__row textarea:focus {
  border-color: var(--lc-accent);
  outline: 1px solid var(--lc-accent);
}

.lc-function-test__error {
  color: var(--lc-danger);
  font-size: 10px;
}

.lc-function-test__result {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 9px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: rgba(10, 30, 61, 0.55);
}

.lc-function-test__result--fail {
  border-color: var(--lc-danger-border);
  background: var(--lc-danger-surface);
}

.lc-function-test__status {
  color: var(--lc-text-secondary);
  font-size: 10px;
}

.lc-function-test__result--fail .lc-function-test__status {
  color: var(--lc-danger);
  font-weight: 600;
}

.lc-function-test__value {
  max-height: 180px;
  margin: 0;
  overflow: auto;
  color: var(--lc-text);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.lc-function-test__note {
  margin: 0;
  color: var(--lc-text-muted);
  font-size: 10px;
  line-height: 1.5;
}

.lc-function-test :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .lc-function-test__button {
    transition: none;
  }
}
</style>
