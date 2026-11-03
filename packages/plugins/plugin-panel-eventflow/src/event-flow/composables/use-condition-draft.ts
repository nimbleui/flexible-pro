import { computed, onUnmounted, ref, watch } from 'vue'
import type { ComputedRef } from 'vue'
import type { ActionDeclaration } from '@lc/schema'
import { actionPath, createExpression, isExpressionString } from '@lc/schema'
import type { EventFlowStore } from './use-event-flow-store'

/** 输入停顿多久后自动落文档；太短会把一次编辑切成多条历史 */
const CONDITION_COMMIT_DELAY_MS = 500

/**
 * 动作执行条件（表达式）的草稿与提交。
 *
 * 条件写在 `action.condition` 里，是带 `{{ }}` 标记的表达式字符串，
 * 因此读取要经过 `isExpressionString`，写入要经过 `createExpression`。
 */
export function useConditionDraft(
  store: EventFlowStore,
  selectedAction: ComputedRef<ActionDeclaration | undefined>,
) {
  const { commit } = store

  const conditionDraft = ref('')
  let conditionTimer: ReturnType<typeof setTimeout> | null = null

  function cancelConditionTimer(): void {
    if (conditionTimer) {
      clearTimeout(conditionTimer)
      conditionTimer = null
    }
  }

  const conditionText = computed<string>(() => {
    const condition = selectedAction.value?.condition
    return isExpressionString(condition) ? condition.raw : ''
  })

  // 编辑器内部按字符更新草稿；真正写文档放在失焦时，避免每输入一个字产生一条历史
  watch(
    conditionText,
    (value) => {
      conditionDraft.value = value
    },
    { immediate: true },
  )

  // 输入停顿 500ms 后自动写入：CodeMirror 的 blur 在部分宿主里不可靠，
  // 光靠失焦提交会让用户切走后丢草稿。与文档值相同的草稿不重复写历史。
  watch(conditionDraft, (value) => {
    if (value === conditionText.value) return

    cancelConditionTimer()
    conditionTimer = setTimeout(() => {
      conditionTimer = null
      commitConditionText(value)
    }, CONDITION_COMMIT_DELAY_MS)
  })

  function commitConditionText(input: string): void {
    const action = selectedAction.value
    if (!action) return

    const raw = input.trim()
    if (raw === '') {
      if (action.condition === undefined) return
      commit([{ op: 'remove', path: actionPath(action.id, 'condition') }], '修改动作配置')
      return
    }
    if (isExpressionString(action.condition) && action.condition.raw === raw) return

    commit(
      [
        {
          op: 'replace',
          path: actionPath(action.id, 'condition'),
          value: createExpression(raw),
        },
      ],
      '修改动作配置',
    )
  }

  function commitConditionDraft(): void {
    cancelConditionTimer()
    commitConditionText(conditionDraft.value)
  }

  onUnmounted(cancelConditionTimer)

  return { conditionDraft, commitConditionDraft, cancelConditionTimer }
}
