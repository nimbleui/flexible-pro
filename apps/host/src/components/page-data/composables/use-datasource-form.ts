import { computed, reactive, ref } from 'vue'
import type { DataSourceSchemaDef } from '@lc/schema'
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
import type { EditableSourceType } from '../utils/data-source'
import {
  buildSourceConfig,
  getSourceSample,
  isEditableSource,
  sourceTypeLabel,
} from '../utils/data-source'
import type { PageDataStore } from './use-page-data-store'

/** 接口数据源表单：草稿态、状态展示与写回 `schema.datasources` */
export function useDatasourceForm(store: PageDataStore) {
  const {
    doc,
    dataSource,
    datasources,
    typeOptions,
    writeArray,
    availableDataNames,
    sourceState,
  } = store

  const sourceEditing = ref<EditingKey>(null)
  const sourceError = ref('')
  const sourceDraft = reactive({
    id: '',
    type: 'rest' as EditableSourceType,
    url: '',
    description: '',
    autoFetch: true,
  })
  const resultDraft = ref<TypeNodeDraft>(createTypeNode('', 'object'))
  const deletingSource = ref<number | null>(null)

  const sourceTypeOptions = computed(() => {
    const current =
      typeof sourceEditing.value === 'number'
        ? datasources.value[sourceEditing.value]
        : undefined
    return current
      ? typeOptions.value.filter((option) => option.id !== `datasource:${current.id}`)
      : typeOptions.value
  })

  function resetSourceForm(): void {
    sourceEditing.value = null
    sourceError.value = ''
    deletingSource.value = null
    sourceDraft.id = ''
    sourceDraft.type = 'rest'
    sourceDraft.url = ''
    sourceDraft.description = ''
    sourceDraft.autoFetch = true
    resultDraft.value = createTypeNode('', 'object')
  }

  function openSourceCreate(): void {
    resetSourceForm()
    sourceEditing.value = 'new'
  }

  function openSourceEdit(index: number): void {
    const source = datasources.value[index]
    if (!source || !isEditableSource(source)) return

    resetSourceForm()
    sourceEditing.value = index
    sourceDraft.id = source.id
    sourceDraft.type = source.type
    sourceDraft.url = source.config.kind === 'rest' ? source.config.url : ''
    sourceDraft.description = source.description ?? ''
    sourceDraft.autoFetch = source.autoFetch !== false

    const sample = getSourceSample(source)
    const type =
      source.resultType ??
      (sample === undefined ? { kind: 'object' as const } : valueTypeFromSample(sample))
    resultDraft.value = typeNodeFromValueType('', type, sample)
  }

  function sourceStatusText(id: string): string {
    const state = sourceState(id)
    if (!state) return '未取数'
    if (state.loading) return '加载中…'
    if (state.error) return `失败：${state.error}`
    return state.loaded ? '已加载' : '未取数'
  }

  function sourceStatusTone(id: string): string {
    const state = sourceState(id)
    if (!state) return 'idle'
    if (state.loading) return 'loading'
    if (state.error) return 'error'
    return state.loaded ? 'loaded' : 'idle'
  }

  function refreshSource(id: string): void {
    void dataSource?.fetch(id)
  }

  /**
   * 数据源表单校验；返回错误文案，空串表示通过。
   *
   * 重名判定与变量共用一张表（两者最终挂在同一个 `data` 命名空间下），
   * 但要先把自己排除掉：编辑时旧 id 仍在列表里，不去掉就会判成自重名。
   */
  function sourceFormError(
    editing: EditingKey,
    existing: DataSourceSchemaDef | undefined,
    id: string,
  ): string {
    const taken = availableDataNames(editing === 'new' ? null : editing)
    if (typeof editing === 'number' && existing) taken.delete(existing.id)

    const nameError = validateDataName(id, taken, '数据源名')
    if (nameError) return nameError

    if (sourceDraft.type === 'rest' && sourceDraft.url.trim() === '') {
      return 'REST 数据源需要填写请求地址'
    }
    return ''
  }

  /**
   * 表单状态 → 数据源声明。
   *
   * 先展开 `existing`：transform / cache / pollingInterval 这些表单没有控件的字段
   * 必须原样带过去，否则编辑一次标题就会把高级配置静默清空。
   * 结果类型与样本都取自结构化类型编辑器，二者允许不一致（sample 只是补全用的快照）。
   */
  function sourceFromDraft(
    existing: DataSourceSchemaDef | undefined,
    id: string,
  ): DataSourceSchemaDef {
    const url = sourceDraft.url.trim()
    const description = sourceDraft.description.trim()
    const resultType = valueTypeFromTypeNode(resultDraft.value)
    const resultSample = sampleFromTypeNode(resultDraft.value)

    return {
      ...(existing ?? {}),
      id,
      type: sourceDraft.type,
      autoFetch: sourceDraft.autoFetch,
      resultType,
      ...(description === '' ? {} : { description }),
      ...(resultSample === undefined ? {} : { sample: resultSample }),
      config: buildSourceConfig(existing, sourceDraft.type, url, resultSample),
    }
  }

  function saveSource(): void {
    const id = sourceDraft.id.trim()
    const editing = sourceEditing.value
    const existing = typeof editing === 'number' ? datasources.value[editing] : undefined

    const error = sourceFormError(editing, existing, id)
    if (error) {
      sourceError.value = error
      return
    }

    const current = doc.model.schema.datasources
    writeArray(
      'datasources',
      current,
      upsertAt(current ?? [], editing, sourceFromDraft(existing, id)),
      isCreating(editing) ? '新增页面数据源' : '修改页面数据源',
    )
    resetSourceForm()
  }

  function removeSource(index: number): void {
    const current = doc.model.schema.datasources
    if (!current) return

    const next = current.filter((_, position) => position !== index)
    writeArray('datasources', current, next, '删除页面数据源')
    deletingSource.value = null
  }

  return {
    sourceEditing,
    sourceError,
    sourceDraft,
    resultDraft,
    deletingSource,
    sourceTypeOptions,
    resetSourceForm,
    openSourceCreate,
    openSourceEdit,
    sourceStatusText,
    sourceStatusTone,
    refreshSource,
    saveSource,
    removeSource,
  }
}
