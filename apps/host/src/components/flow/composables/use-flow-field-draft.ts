import { ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { ActionFieldKind } from '@lc/schema'
import { createExpression, isExpressionString } from '@lc/schema'
import type { JsonDraftResult } from '@lc/shared'
import { formatJsonValue, parseJsonDraft } from '@lc/shared'

/**
 * 右栏表单的「草稿 → 提交」状态机。
 *
 * 编辑器每写入一次就产生一条可撤销历史，所以输入框不能逐字符落文档：一次改名会留下
 * 十几个撤销步骤。这里把编辑留在本地草稿里，只在失焦（或选择类控件的直接输入）且
 * 值合法时才提交一次；非法值只回错误文案，草稿保持原样，用户不会敲了一半被回滚。
 */

/** 整串形如 `{{ ... }}` 的文本；与表达式引擎「求值而非插值」的判定口径一致 */
const WHOLE_EXPRESSION = /^\{\{.*\}\}$/s

/** 一次草稿提交的输入契约：读文档、解析文本、写文档三段各自可替换 */
export interface FlowFieldDraftSource {
  /** 文档当前值 → 输入框显示文本；每次响应式重算都会重新调用 */
  display: () => string
  /** 草稿文本 → 待提交值；非法时只返回错误，不产出可提交值 */
  parse: (text: string) => JsonDraftResult
  /** 把合法值写进编辑器；`undefined` 表示清空该字段 */
  commit: (value: unknown) => void
}

/** 输入框绑定所需的草稿状态 */
export interface FlowFieldDraft {
  /** 输入框当前文本 */
  draft: Ref<string>
  /** 上一次提交失败的错误文案；空串表示没有错误 */
  error: Ref<string>
  /** 绑定到 `@input` */
  onInput: (event: Event) => void
  /** 绑定到 `@change` / `@blur`：解析成功后才提交 */
  commitDraft: () => void
}

/**
 * 为单个文本类字段建立草稿状态。
 *
 * 副作用：注册一个跟随文档值的 watch。撤销、切换选中项、其它面板写入都会把显示值
 * 拉回来，但用户正在编辑（草稿为脏）时绝不覆盖——否则每按一次 Ctrl+Z 都可能吞掉输入。
 */
export function useFlowFieldDraft(source: FlowFieldDraftSource): FlowFieldDraft {
  const draft = ref(source.display())
  const error = ref('')

  /** 本地是否有未提交编辑；为真时文档回写让位给用户输入 */
  const isDirty = ref(false)

  watch(
    () => source.display(),
    (text) => {
      if (isDirty.value) return
      draft.value = text
      error.value = ''
    },
  )

  function onInput(event: Event): void {
    const target = event.target
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement))
      return

    draft.value = target.value
    isDirty.value = true
  }

  function commitDraft(): void {
    const text = draft.value

    // 没编辑过、或编辑后又改回原值：不提交，避免一次「点进来又点出去」留下空历史
    if (!isDirty.value || text === source.display()) {
      isDirty.value = false
      error.value = ''
      return
    }

    const parsed = source.parse(text)
    if (!parsed.ok) {
      error.value = parsed.error
      return
    }

    error.value = ''
    isDirty.value = false
    source.commit(parsed.value)

    // 提交后以文档为准回显：数字会被格式化，JSON 会重新缩进，显示结果与输入文本未必相同
    const displayed = source.display()
    if (displayed !== draft.value) draft.value = displayed
  }

  return { draft, error, onInput, commitDraft }
}

/**
 * 文档值 → 输入框文本。
 *
 * 表达式对象按 `raw` 回显，用户看到的就是自己写进去的那串 `{{ }}`；否则再次提交会把
 * 它展开成一坨 JSON 文本。`json` 形态走统一的格式化，其余标量按 `String` 折叠。
 */
export function fieldDraftText(kind: ActionFieldKind, value: unknown): string {
  if (kind === 'json') return formatJsonValue(value)
  if (value === undefined || value === null) return ''
  if (isExpressionString(value)) return value.raw
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  return formatJsonValue(value)
}

/**
 * 输入框文本 → 字段的待提交值，按控件形态折叠。
 *
 * `select` / `toggle` / `ref` 三种形态不经过这里：它们的值域由控件本身约束（下拉的
 * 候选就是合法集），选择即合法，直接提交即可。
 */
export function parseFieldDraft(kind: ActionFieldKind, text: string): JsonDraftResult {
  const trimmed = text.trim()

  if (kind === 'json') return parseJsonDraft(text)

  if (kind === 'number') {
    if (trimmed === '') return { ok: true, value: undefined }

    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return { ok: false, error: '请输入有效数字' }

    return { ok: true, value: parsed }
  }

  if (kind === 'expression') {
    if (trimmed === '') return { ok: true, value: undefined }
    // 漏写花括号时替作者补上：条件位置存裸文本会被当作常量而恒为真，校验必然报错
    const raw = WHOLE_EXPRESSION.test(trimmed) ? trimmed : `{{ ${trimmed} }}`

    return { ok: true, value: createExpression(raw) }
  }

  return { ok: true, value: trimmed === '' ? undefined : text }
}

/** JSON 对象形态的草稿解析：用于节点的输入/输出映射，非对象一律拒绝 */
export function parseObjectDraft(text: string): JsonDraftResult {
  const parsed = parseJsonDraft(text)
  if (!parsed.ok) return parsed
  if (parsed.value === undefined) return parsed

  return isJsonObject(parsed.value)
    ? { ok: true, value: parsed.value }
    : { ok: false, error: '映射必须是 JSON 对象' }
}

/** 文本字段的合法提交值：字符串，或表示「清空」的 undefined */
export function isTextOrEmpty(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/**
 * JSON 解析结果的对象判定。
 *
 * 映射字段在执行器里按 `Object.entries` 遍历，数组与字面量虽然也是合法 JSON，
 * 但语义完全不同，必须在设计期就挡下而不是等到运行时报错。
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
