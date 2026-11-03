import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { formatJsonValue, parseJsonDraft } from '@lc/shared'
import type { ActionDeclaration, ActionFieldSchema } from '@lc/schema'
import { actionPath, isExpressionString } from '@lc/schema'
import { actionTypeTitle } from '../constants/action-tone'
import { inputValue, readFieldInput, sameConfigValue } from '../utils/action-field'
import type { EventFlowStore } from './use-event-flow-store'

/** 动作选择器里的一个候选项 */
export interface ActionOption {
  /** 写入 config 的动作 id */
  value: string
  /** 展示名：自定义 name 优先，否则取类型标题 */
  label: string
}

/** 草稿归属键：JSON 输入框按「动作 + 字段」区分，切换动作时不会串草稿 */
function jsonKeyOf(actionId: string, fieldKey: string): string {
  return `${actionId}:${fieldKey}`
}

/**
 * 右栏动作配置表单：普通字段、动作选择器与 JSON 字段的读取、校验与提交。
 *
 * `config` 是整体替换的（JSON Patch 的 replace 需要完整对象），所以每个字段都按
 * 「原配置 + 单键覆盖」重建；值没变直接返回，避免一次无意义的点击留下一条可撤销的历史。
 */
export function useActionFieldEditor(
  store: EventFlowStore,
  selectedAction: ComputedRef<ActionDeclaration | undefined>,
  selectedActionId: Ref<string | undefined>,
) {
  const { document, version, commit } = store

  const jsonDraft = ref<string | null>(null)
  const jsonDraftKey = ref<string | null>(null)
  const jsonError = ref('')

  watch(selectedActionId, () => {
    jsonDraft.value = null
    jsonDraftKey.value = null
    jsonError.value = ''
  })

  /**
   * `kind: 'action'` 字段的候选项。
   *
   * 排除当前动作自身：分支目标指向自己是环，校验会报错，与其让用户选出来再被拦，
   * 不如在选择器里就不出现。
   */
  const actionOptions = computed<ActionOption[]>(() => {
    version.value
    const table = document?.model.schema.actions ?? {}
    const self = selectedActionId.value

    return Object.values(table)
      .filter((action) => action.id !== self)
      .map((action) => ({
        value: action.id,
        label: action.name ?? actionTypeTitle(action.type),
      }))
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

  /**
   * 文本框显示值。
   *
   * 表达式对象按 `raw` 回显（含 `{{ }}`），这样用户在框里看到的就是它写进去的样子，
   * 再次提交也不会被 `JSON.stringify` 展开成一坨 `{"type":"expression",...}`。
   */
  function fieldText(field: ActionFieldSchema): string {
    const value = selectedAction.value?.config[field.key]
    if (value === undefined || value === null) return ''
    if (isExpressionString(value)) return value.raw
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
    if (field.kind === 'action') {
      // 动作被删除后引用会悬空，校验已报错；这里仍要显示出来，否则用户看不见断链在哪
      const value = fieldSelectValue(field)
      return value !== '' && !actionOptions.value.some((option) => option.value === value)
    }

    const value = fieldSelectValue(field)
    if (value === '') return false
    return !(field.options ?? []).some((option) => option.value === value)
  }

  /**
   * 提交一个字段的新值。
   *
   * `undefined` 表示「清空」，走删键而不是写 `undefined`：动作 config 会整体序列化进
   * 文档，留一个值为 `undefined` 的键会在 JSON 里变成一个真实存在的 `null`。
   */
  function onFieldChange(field: ActionFieldSchema, event: Event): void {
    const action = selectedAction.value
    if (!action) return

    const input = readFieldInput(field, event.target)
    if (!input.accepted) return
    if (sameConfigValue(action.config[field.key], input.value)) return

    const config: Record<string, unknown> = { ...action.config }
    if (input.value === undefined) delete config[field.key]
    else config[field.key] = input.value

    commit(
      [{ op: 'replace', path: actionPath(action.id, 'config'), value: config }],
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
    actionOptions,
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
