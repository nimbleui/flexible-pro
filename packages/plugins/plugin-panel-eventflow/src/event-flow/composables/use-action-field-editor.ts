import { ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { ActionDeclaration, ActionFieldSchema } from '@lc/schema'
import { actionPath } from '@lc/schema'
import { inputValue, readFieldInput } from '../utils/action-field'
import { formatJsonValue, jsonKeyOf, parseJsonDraft } from '../utils/json-draft'
import type { EventFlowStore } from './use-event-flow-store'

/**
 * 右栏动作配置表单：普通字段与 JSON 字段的读取、校验与提交。
 *
 * `config` 是整体替换的（JSON Patch 的 replace 需要完整对象），所以每个字段都按
 * 「原配置 + 单键覆盖」重建；值没变直接返回，避免一次无意义的点击留下一条可撤销的历史。
 */
export function useActionFieldEditor(
  store: EventFlowStore,
  selectedAction: ComputedRef<ActionDeclaration | undefined>,
  selectedActionId: Ref<string | undefined>,
) {
  const { commit } = store

  const jsonDraft = ref<string | null>(null)
  const jsonDraftKey = ref<string | null>(null)
  const jsonError = ref('')

  watch(selectedActionId, () => {
    jsonDraft.value = null
    jsonDraftKey.value = null
    jsonError.value = ''
  })

  function commitActionName(event: Event): void {
    const action = selectedAction.value
    if (!action) return

    const name = inputValue(event).trim()
    if (name === '') {
      if (action.name === undefined) return
      commit([{ op: 'remove', path: actionPath(action.id, 'name') }], '修改动作配置')
      return
    }
    if (name === action.name) return

    commit(
      [{ op: 'replace', path: actionPath(action.id, 'name'), value: name }],
      '修改动作配置',
    )
  }

  function fieldText(field: ActionFieldSchema): string {
    const value = selectedAction.value?.config[field.key]
    if (value === undefined || value === null) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return JSON.stringify(value) ?? ''
  }

  function fieldNumber(field: ActionFieldSchema): number | '' {
    const value = selectedAction.value?.config[field.key]
    return typeof value === 'number' ? value : ''
  }

  function fieldChecked(field: ActionFieldSchema): boolean {
    return selectedAction.value?.config[field.key] === true
  }

  function fieldSelectValue(field: ActionFieldSchema): string {
    const value = selectedAction.value?.config[field.key]
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return ''
  }

  function isUnlistedSelectValue(field: ActionFieldSchema): boolean {
    const value = fieldSelectValue(field)
    if (value === '') return false
    return !(field.options ?? []).some((option) => option.value === value)
  }

  function onFieldChange(field: ActionFieldSchema, event: Event): void {
    const action = selectedAction.value
    if (!action) return

    const input = readFieldInput(field, event.target)
    if (!input.accepted) return
    if (action.config[field.key] === input.value) return

    commit(
      [
        {
          op: 'replace',
          path: actionPath(action.id, 'config'),
          value: { ...action.config, [field.key]: input.value },
        },
      ],
      '修改动作配置',
    )
  }

  function jsonText(field: ActionFieldSchema): string {
    const action = selectedAction.value
    if (!action) return ''
    const key = jsonKeyOf(action.id, field.key)
    if (jsonDraftKey.value === key && jsonDraft.value !== null) return jsonDraft.value
    return formatJsonValue(action.config[field.key])
  }

  function jsonErrorFor(field: ActionFieldSchema): string {
    const action = selectedAction.value
    if (!action) return ''
    return jsonDraftKey.value === jsonKeyOf(action.id, field.key) ? jsonError.value : ''
  }

  function onJsonInput(field: ActionFieldSchema, event: Event): void {
    const action = selectedAction.value
    if (!action) return
    jsonDraftKey.value = jsonKeyOf(action.id, field.key)
    jsonDraft.value = inputValue(event)
    jsonError.value = ''
  }

  /**
   * 提交 JSON 字段：解析成功后才落文档并清草稿。
   *
   * 读文本走 `jsonText`，与输入框显示的是同一份内容，避免「看到的」和「提交的」
   * 因为草稿归属判断而分叉。
   */
  function commitJson(field: ActionFieldSchema): void {
    const action = selectedAction.value
    if (!action) return

    const text = jsonText(field)
    const parsed = parseJsonDraft(text)
    if (!parsed.ok) {
      jsonError.value = parsed.error
      return
    }

    const config: Record<string, unknown> = { ...action.config }
    if (text.trim() === '') delete config[field.key]
    else config[field.key] = parsed.value

    jsonError.value = ''
    jsonDraft.value = null
    jsonDraftKey.value = null
    commit(
      [{ op: 'replace', path: actionPath(action.id, 'config'), value: config }],
      '修改动作配置',
    )
  }

  return {
    commitActionName,
    fieldText,
    fieldNumber,
    fieldChecked,
    fieldSelectValue,
    isUnlistedSelectValue,
    onFieldChange,
    jsonText,
    jsonErrorFor,
    onJsonInput,
    commitJson,
  }
}
