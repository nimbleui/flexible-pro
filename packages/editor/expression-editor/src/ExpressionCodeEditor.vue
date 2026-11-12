<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from 'vue'
import type { FunctionDescriptor } from '@lc/schema'
import type { ScopeSymbol, SignatureHelp } from '@lc/expression/editor'
import { completeExpression, diagnoseExpression, signatureHelp } from '@lc/expression/editor'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippet as snippetTemplate,
  startCompletion,
} from '@codemirror/autocomplete'
import type { CompletionSource } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { linter } from '@codemirror/lint'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view'

const props = withDefaults(
  defineProps<{
    /** v-model 绑定的表达式原文；每次编辑经 update:modelValue 实时回抛，必填故无默认值 */
    modelValue: string
    /** 当前生效函数；补全回调每次实时读取，全局函数变化后无需重建编辑器 */
    functions: readonly FunctionDescriptor[]
    /** 当前作用域可见符号；函数体里只有形参，页面表达式里包含 data/page/route */
    symbols?: readonly ScopeSymbol[]
    /**
     * 补全模式：`template` 只在 `{{ ... }}` 内部提示，适合属性值这类混合文本。
     *
     * @default 'expression'
     */
    mode?: 'expression' | 'template'
    /** 是否显示调用签名栏；模板模式下默认不显示 @default true */
    showSignature?: boolean
    /** 空内容时的占位文案；仅作 CodeMirror 空文档提示，不参与 modelValue @default '' */
    placeholder?: string
    /** 编辑区域的无障碍标签，挂到 CodeMirror 容器的 aria-label @default '表达式' */
    ariaLabel?: string
    /**
     * 编辑器最小高度，单位 CSS 像素；只是下界——内容超出后编辑器随内容增高，该值不再约束总高。
     *
     * @default 96
     */
    minHeight?: number
    /**
     * 是否显示行号槽；控制台式的大编辑器开启，行内表单编辑器保持紧凑。
     * 挂载时读取一次，运行中切换不会重建扩展。
     *
     * @default false
     */
    lineNumbers?: boolean
  }>(),
  {
    symbols: () => [],
    mode: 'expression',
    showSignature: true,
    placeholder: '',
    ariaLabel: '表达式',
    minHeight: 96,
    lineNumbers: false,
  },
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'blur'): void
}>()

const host = shallowRef<HTMLDivElement | null>(null)
const view = shallowRef<EditorView | null>(null)
const signature = shallowRef<SignatureHelp | null>(null)

const activeParameterIndex = computed(() => {
  const current = signature.value
  if (!current) return 0
  return Math.min(current.activeParameter, Math.max(current.params.length - 1, 0))
})

function refreshSignature(editor: EditorView): void {
  if (!props.showSignature || props.mode === 'template') {
    signature.value = null
    return
  }

  signature.value = signatureHelp({
    text: editor.state.doc.toString(),
    offset: editor.state.selection.main.head,
    functions: props.functions,
  })
}

const completionSource: CompletionSource = (context) => {
  const result = completeExpression({
    text: context.state.doc.toString(),
    offset: context.pos,
    functions: props.functions,
    symbols: props.symbols,
    mode: props.mode,
  })

  if (result.options.length === 0) return null

  return {
    from: result.from,
    options: result.options.map((item) => ({
      label: item.label,
      type: item.kind,
      detail: item.detail,
      info: item.documentation,
      apply: item.snippet ? snippetTemplate(item.snippet) : (item.insertText ?? item.label),
    })),
  }
}

const lintExtension = linter(
  (editor) => {
    const length = editor.state.doc.length
    return diagnoseExpression(editor.state.doc.toString(), props.mode).map((issue) => ({
      from: Math.min(issue.from, Math.max(length - 1, 0)),
      to: Math.min(Math.max(issue.to, issue.from + 1), length),
      severity: 'error' as const,
      message: issue.message,
    }))
  },
  { delay: 300 },
)

const theme = EditorView.theme({
  '&': {
    minHeight: `${props.minHeight}px`,
    border: '1px solid var(--lc-border)',
    borderRadius: '7px',
    background: 'var(--lc-surface-sunken)',
    color: 'var(--lc-text)',
    fontSize: '12px',
  },
  '&.cm-focused': {
    borderColor: 'var(--lc-accent)',
    outline: '1px solid var(--lc-accent)',
  },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '7px 9px',
    caretColor: 'var(--lc-accent-bright)',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-gutters': {
    background: 'var(--lc-surface)',
    color: 'var(--lc-text-muted)',
    border: 'none',
    borderRight: '1px solid var(--lc-border)',
    fontSize: '11px',
  },
  '.cm-placeholder': {
    color: 'var(--lc-text-muted)',
  },
  '.cm-tooltip': {
    border: '1px solid var(--lc-border-strong)',
    borderRadius: '7px',
    background: 'var(--lc-surface)',
    color: 'var(--lc-text)',
    boxShadow: '0 12px 32px rgba(0, 6, 18, 0.5)',
  },
  '.cm-tooltip-autocomplete > ul > li': {
    padding: '3px 8px',
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    fontSize: '12px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--lc-accent-soft)',
    color: 'var(--lc-accent-bright)',
  },
  '.cm-completionDetail': {
    marginLeft: '10px',
    color: 'var(--lc-text-muted)',
    fontStyle: 'normal',
  },
  '.cm-diagnostic': {
    padding: '4px 8px',
    borderLeft: '3px solid var(--lc-danger)',
    background: 'var(--lc-surface)',
    color: 'var(--lc-text)',
    fontSize: '11px',
  },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--lc-danger)',
    textUnderlineOffset: '3px',
  },
})

const extensions = [
  history(),
  closeBrackets(),
  ...(props.lineNumbers ? [lineNumbers()] : []),
  autocompletion({
    override: [completionSource],
    activateOnTyping: true,
  }),
  lintExtension,
  keymap.of([
    { key: 'Ctrl-Space', run: startCompletion },
    ...completionKeymap,
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...historyKeymap,
    indentWithTab,
  ]),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel }),
  EditorView.domEventHandlers({
    // 表单/面板可以借此在失焦时一次性提交，避免每敲一个字符写一条历史
    blur: () => emit('blur'),
  }),
  placeholder(props.placeholder),
  theme,
  EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      emit('update:modelValue', update.state.doc.toString())

      // 默认只在输入单词字符时自动弹出；成员访问需要在句点后手动拉起
      const typed = update.transactions.some((transaction) =>
        transaction.isUserEvent('input.type'),
      )
      const head = update.state.selection.main.head
      if (typed && update.state.doc.sliceString(Math.max(0, head - 1), head) === '.') {
        startCompletion(update.view)
      }
    }

    if (update.docChanged || update.selectionSet) refreshSignature(update.view)
  }),
]

onMounted(() => {
  if (!host.value) return
  view.value = new EditorView({
    state: EditorState.create({ doc: props.modelValue, extensions }),
    parent: host.value,
  })
  refreshSignature(view.value)
})

// 全局函数变化时，当前正在显示的签名也要用新目录重新解释
watch(
  () => props.functions,
  () => {
    const current = view.value
    if (current) refreshSignature(current)
  },
)

watch(
  () => props.modelValue,
  (value) => {
    const current = view.value
    if (!current) return
    const text = current.state.doc.toString()
    if (text === value) return
    current.dispatch({ changes: { from: 0, to: text.length, insert: value } })
  },
)

onUnmounted(() => {
  view.value?.destroy()
  view.value = null
})

/**
 * 在光标处插入文本并把光标放到插入内容之后。
 *
 * 供「可用函数」参考面板使用：点击函数名等价于在当前光标补全，而不是覆盖全文。
 */
function insert(text: string): void {
  const current = view.value
  if (!current) return

  const { from, to } = current.state.selection.main
  current.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
  })
  current.focus()
}

defineExpose({ insert })
</script>

<template>
  <div class="lc-expression-editor">
    <div ref="host" class="lc-expression-editor__host" />

    <div v-if="signature" class="lc-expression-editor__signature" aria-live="polite">
      <code class="lc-expression-editor__signature-code">
        <span class="lc-expression-editor__signature-name">{{ signature.name }}</span
        >(
        <template v-for="(param, index) in signature.params" :key="`${param}-${index}`">
          <span
            class="lc-expression-editor__signature-param"
            :class="{ 'is-active': index === activeParameterIndex }"
            >{{ param }}</span
          ><span v-if="index < signature.params.length - 1">, </span>
        </template>
        )
      </code>

      <span v-if="signature.kind === 'method'" class="lc-expression-editor__signature-kind">
        方法
      </span>
      <span
        v-if="signature.documentation"
        class="lc-expression-editor__signature-doc"
        :title="signature.documentation"
      >
        {{ signature.documentation }}
      </span>
      <span v-if="signature.params.length > 0" class="lc-expression-editor__signature-count">
        {{ activeParameterIndex + 1 }}/{{ signature.params.length }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.lc-expression-editor {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.lc-expression-editor__host {
  min-width: 0;
}

.lc-expression-editor__signature {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--lc-border);
  border-radius: 6px;
  background: rgba(6, 17, 33, 0.7);
}

.lc-expression-editor__signature-code {
  flex: none;
  color: var(--lc-text-secondary);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 10px;
}

.lc-expression-editor__signature-name {
  color: var(--lc-accent-bright);
}

.lc-expression-editor__signature-param {
  color: var(--lc-text-muted);
}

.lc-expression-editor__signature-param.is-active {
  color: var(--lc-accent-bright);
  font-weight: 600;
}

.lc-expression-editor__signature-kind {
  flex: none;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--lc-accent-soft);
  color: var(--lc-accent);
  font-size: var(--lc-font-size-3xs);
  line-height: 14px;
}

.lc-expression-editor__signature-doc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--lc-text-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-expression-editor__signature-count {
  flex: none;
  color: var(--lc-text-muted);
  font-size: var(--lc-font-size-3xs);
  font-variant-numeric: tabular-nums;
}
</style>
