import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { formatJsonValue, parseJsonDraft } from '@lc/shared'
import type { ActionDeclaration, ActionFieldSchema, RefOption } from '@lc/schema'
import { actionPath, isExpressionString, listRefOptions } from '@lc/schema'
import { inputValue, readFieldInput, sameConfigValue } from '../utils/action-field'
import type { EventFlowStore } from './use-event-flow-store'

/** 草稿归属键：JSON 输入框按「动作 + 字段」区分，切换动作时不会串草稿 */
function jsonKeyOf(actionId: string, fieldKey: string): string {
  return `${actionId}:${fieldKey}`
}

/**
 * 右栏动作配置表单：普通字段、引用选择器与 JSON 字段的读取、校验与提交。
 *
 * `config` 是整体替换的（JSON Patch 的 replace 需要完整对象），所以每个字段都按
 * 「原配置 + 单键覆盖」重建；值没变直接返回，避免一次无意义的点击留下一条可撤销的历史。
 */
export function useActionFieldEditor(
  store: EventFlowStore,
  selectedAction: ComputedRef<ActionDeclaration | undefined>,
  selectedActionId: Ref<string | undefined>,
) {
  const { document, version, commit, flow } = store

  const jsonDraft = ref<string | null>(null)
  const jsonDraftKey = ref<string | null>(null)
  const jsonError = ref('')

  watch(selectedActionId, () => {
    jsonDraft.value = null
    jsonDraftKey.value = null
    jsonError.value = ''
  })

  /**
   * 引用型字段的候选项。
   *
   * 候选一律由 `listRefOptions` 从当前文档算出，面板不自己拼清单：分支目标、序列成员、
   * 本页变量与数据源在事件流、右栏节点事件、流程编辑器里都要列一遍，各拼一次早晚分叉。
   *
   * `exclude` 只给动作类字段传当前动作：指向自己是环，与其让作者选出来再被校验拦下，
   * 不如在选择器里就不出现。
   */
  function refOptions(field: ActionFieldSchema): readonly RefOption[] {
    version.value
    const schema = document?.model.schema
    if (!schema || field.ref === undefined) return []

    return listRefOptions(field.ref, {
      schema,
      flows: flow?.list(),
      exclude: field.ref === 'action' ? selectedActionId.value : undefined,
    })
  }

  /** 多选字段的当前值；非数组的历史数据（手填 JSON 时代留下的）按空处理 */
  function fieldMultiValue(field: ActionFieldSchema): string[] {
    const value = selectedAction.value?.config[field.key]
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  }

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

  /**
   * 当前值不在候选里时返回 true，模板据此追加一个只读选项。
   *
   * 必须显示而不是静默回落到「未设置」：动作被删除、数据源改名之后引用会悬空，
   * 校验已经报了错，可如果下拉里看不见那个断掉的值，用户无从判断断链在哪。
   */
  function isUnlistedSelectValue(field: ActionFieldSchema): boolean {
    if (field.multiple) return false

    const value = fieldSelectValue(field)
    if (value === '') return false
    if (field.kind === 'ref') {
      return !refOptions(field).some((option) => option.value === value)
    }

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

  /**
   * 未登记字段声明的动作类型，直接编辑整份 config。
   *
   * 存在的理由：插件自定义动作没有内置字段表，只给一句「没有可渲染的内置字段」
   * 等于把作者挡在门外——他的动作本身是合法的，config 也是 JSON 可序列化的，
   * 平台只是不知道该怎么画表单。给一个原始编辑入口比给一个死提示诚实。
   */
  const configDraft = ref<string | null>(null)
  const configDraftActionId = ref<string | null>(null)
  const configError = ref('')

  watch(selectedActionId, () => {
    configDraft.value = null
    configDraftActionId.value = null
    configError.value = ''
  })

  function configJsonText(): string {
    const action = selectedAction.value
    if (!action) return ''
    if (configDraftActionId.value === action.id && configDraft.value !== null) {
      return configDraft.value
    }
    return formatJsonValue(action.config)
  }

  function onConfigJsonInput(event: Event): void {
    const action = selectedAction.value
    if (!action) return
    configDraftActionId.value = action.id
    configDraft.value = inputValue(event)
    configError.value = ''
  }

  function commitConfigJson(): void {
    const action = selectedAction.value
    if (!action) return

    const parsed = parseJsonDraft(configJsonText())
    if (!parsed.ok) {
      configError.value = parsed.error
      return
    }
    if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      configError.value = '动作 config 必须是一个 JSON 对象'
      return
    }

    configError.value = ''
    configDraft.value = null
    configDraftActionId.value = null
    commit(
      [
        {
          op: 'replace',
          path: actionPath(action.id, 'config'),
          value: parsed.value as Record<string, unknown>,
        },
      ],
      '修改动作配置',
    )
  }

  return {
    refOptions,
    fieldMultiValue,
    configJsonText,
    configError,
    onConfigJsonInput,
    commitConfigJson,
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
