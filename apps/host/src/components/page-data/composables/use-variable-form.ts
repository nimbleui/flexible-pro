import { computed, ref } from 'vue'
import type { PageVariableSchema } from '@lc/schema'
import { valueTypeFromSample } from '@lc/expression/editor'
import {
  createTypeNode,
  sampleFromTypeNode,
  typeNodeFromValueType,
  valueTypeFromTypeNode,
} from '../../common/type-node'
import type { TypeNodeDraft } from '../../common/type-node'
import type { EditingKey } from '../utils/data-naming'
import { isCreating, upsertAt, validateDataName } from '../utils/data-naming'
import type { PageDataStore } from './use-page-data-store'

/** 页面变量表单：草稿态、校验与写回 `schema.variables` */
export function useVariableForm(store: PageDataStore) {
  const { doc, variables, typeOptions, writeArray, availableDataNames } = store

  const variableEditing = ref<EditingKey>(null)
  const variableError = ref('')
  const variableDraft = ref<TypeNodeDraft>(createTypeNode('', 'unknown'))
  const deletingVariable = ref<number | null>(null)

  /** 编辑已有变量时排除自身，避免引用自己的旧定义 */
  const variableTypeOptions = computed(() => {
    const current =
      typeof variableEditing.value === 'number'
        ? variables.value[variableEditing.value]
        : undefined
    return current
      ? typeOptions.value.filter((option) => option.id !== `variable:${current.name}`)
      : typeOptions.value
  })

  function resetVariableForm(): void {
    variableEditing.value = null
    variableError.value = ''
    deletingVariable.value = null
    variableDraft.value = createTypeNode('', 'unknown')
  }

  function openVariableCreate(): void {
    resetVariableForm()
    variableEditing.value = 'new'
  }

  function openVariableEdit(index: number): void {
    const item = variables.value[index]
    if (!item) return

    resetVariableForm()
    variableEditing.value = index

    const type = item.type ?? valueTypeFromSample(item.defaultValue)
    const node = typeNodeFromValueType(item.name, type, item.defaultValue)
    node.description = item.description ?? node.description
    variableDraft.value = node
  }

  /** 草稿 → 变量声明；默认值为 undefined 与空说明都不写字段，避免 patch 里出现无意义的空键 */
  function variableFromDraft(node: TypeNodeDraft, name: string): PageVariableSchema {
    const defaultValue = sampleFromTypeNode(node)
    const description = node.description.trim()

    return {
      name,
      type: valueTypeFromTypeNode(node),
      ...(defaultValue === undefined ? {} : { defaultValue }),
      ...(description === '' ? {} : { description }),
    }
  }

  function saveVariable(): void {
    const node = variableDraft.value
    const name = node.name.trim()
    const editing = variableEditing.value
    const taken = availableDataNames(editing === 'new' ? null : editing)
    const error = validateDataName(name, taken, '变量名')
    if (error) {
      variableError.value = error
      return
    }

    const current = doc.model.schema.variables
    writeArray(
      'variables',
      current,
      upsertAt(current ?? [], editing, variableFromDraft(node, name)),
      isCreating(editing) ? '新增页面变量' : '修改页面变量',
    )
    resetVariableForm()
  }

  function removeVariable(index: number): void {
    const current = doc.model.schema.variables
    if (!current) return

    const next = current.filter((_, position) => position !== index)
    writeArray('variables', current, next, '删除页面变量')
    deletingVariable.value = null
  }

  return {
    variableEditing,
    variableError,
    variableDraft,
    deletingVariable,
    variableTypeOptions,
    resetVariableForm,
    openVariableCreate,
    openVariableEdit,
    saveVariable,
    removeVariable,
  }
}
