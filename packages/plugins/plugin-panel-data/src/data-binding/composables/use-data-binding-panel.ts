import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type {
  CommandService,
  DataSourceService,
  DataSourceState,
  DocumentService,
  SelectionService,
  StateService,
} from '@lc/contracts'
import type { PageSchema } from '@lc/schema'
import type { ExpressionIssue } from '@lc/expression/editor'
import { diagnoseExpression } from '@lc/expression/editor'
import { useAppContext } from '@lc/vue'
import type { PageBinding, UnresolvedRef } from '../utils/binding-scan'
import {
  bindingsReferencing,
  findUnresolvedRefs,
  findUnusedData,
  scanPageBindings,
} from '../utils/binding-scan'
import type { DataItem, DataItemKind } from '../utils/data-items'
import { DATA_GROUP_LABELS, listDataItems } from '../utils/data-items'
import { formatValue } from '../utils/format-value'

/** 左列一行：数据项本体 + 引用计数 + 当前值摘要 */
export interface DataItemRow extends DataItem {
  /** 引用这一项的绑定条数；0 表示没有任何地方读它 */
  references: number
  /** 变量与接口数据的当前值；函数与路由参数在设计期没有值可展示 */
  value?: string
}

/** 左列的一个分组 */
export interface DataItemGroup {
  kind: DataItemKind
  label: string
  items: readonly DataItemRow[]
}

/**
 * 数据绑定面板的状态编排。
 *
 * 面板整体只读：它回答「数据从哪来、被谁读、有没有读错」，增删改仍归页面数据弹框。
 * 唯一的写操作是把选中集切到某条绑定所属的节点，让画布与右栏跟着一起过去。
 */
export function useDataBindingPanel() {
  const ctx = useAppContext()
  const document = ctx.require<DocumentService>('document')
  const selection = ctx.require<SelectionService>('selection')
  const dataSource = ctx.require<DataSourceService>('dataSource')
  const pageState = ctx.require<StateService>('pageState')
  const command = ctx.require<CommandService>('command')

  const version = ref(0)
  const sourceVersion = ref(0)
  const subscriptions: Array<{ dispose(): void }> = []

  /** 左列选中的数据项路径；空串表示「全部」，此时中列不按引用过滤 */
  const selectedPath = ref('')
  const selectedBindingIndex = ref(-1)

  function bump(): void {
    version.value += 1
  }

  onMounted(() => {
    subscriptions.push(document.onDidChange(bump))
    subscriptions.push(
      dataSource.onDidChange(() => {
        sourceVersion.value += 1
      }),
    )
  })

  onUnmounted(() => {
    for (const subscription of subscriptions) subscription.dispose()
    subscriptions.length = 0
  })

  const schema = computed<PageSchema>(() => {
    version.value
    return document.model.schema
  })

  const bindings = computed<readonly PageBinding[]>(() => scanPageBindings(schema.value))

  function sourceState(id: string): DataSourceState | undefined {
    sourceVersion.value
    return dataSource.stateOf(id)
  }

  function sourceStatusText(id: string): string {
    const state = sourceState(id)
    if (state?.error) return state.error
    if (state?.loading) return '请求中'
    return state?.loaded ? '已加载' : '未取数'
  }

  /** 状态色调：只有失败需要一眼看出来，其余保持次要色 */
  function sourceStatusTone(id: string): 'idle' | 'loading' | 'ready' | 'error' {
    const state = sourceState(id)
    if (state?.error) return 'error'
    if (state?.loading) return 'loading'
    if (state?.loaded) return 'ready'
    return 'idle'
  }

  function refreshSource(id: string): void {
    // fetch 不 reject：失败已经写进状态，这里再 catch 一次只会掩盖诊断
    void dataSource.fetch(id)
  }

  const rows = computed<readonly DataItemRow[]>(() => {
    const model = schema.value
    const currentBindings = bindings.value

    return listDataItems(model).map((item) => {
      const row: DataItemRow = {
        ...item,
        references: bindingsReferencing(currentBindings, item.path).length,
      }

      if (item.kind === 'variable') row.value = formatValue(pageState.get(item.name))
      if (item.kind === 'source') row.value = formatValue(sourceState(item.name)?.data)
      return row
    })
  })

  /** 按声明顺序分组；Map 保持插入顺序，所以分组先后与 listDataItems 一致 */
  const groupedRows = computed<readonly DataItemGroup[]>(() => {
    const groups = new Map<DataItemKind, DataItemRow[]>()

    for (const row of rows.value) {
      const bucket = groups.get(row.kind)
      if (bucket) bucket.push(row)
      else groups.set(row.kind, [row])
    }

    return [...groups.entries()].map(([kind, items]) => ({
      kind,
      label: DATA_GROUP_LABELS[kind],
      items,
    }))
  })

  const visibleBindings = computed<readonly PageBinding[]>(() =>
    selectedPath.value === ''
      ? bindings.value
      : bindingsReferencing(bindings.value, selectedPath.value),
  )

  const selectedBinding = computed<PageBinding | undefined>(
    () => visibleBindings.value[selectedBindingIndex.value],
  )

  /** 中列标题：左列选了谁就写谁的名字，没选就写「全部绑定」 */
  const selectedLabel = computed<string>(() => {
    if (selectedPath.value === '') return '全部绑定'
    return rows.value.find((row) => row.path === selectedPath.value)?.name ?? selectedPath.value
  })

  const unresolved = computed<readonly UnresolvedRef[]>(() =>
    findUnresolvedRefs(bindings.value, schema.value),
  )

  const unused = computed<readonly string[]>(() =>
    findUnusedData(bindings.value, schema.value).map((item) => item.name),
  )

  /**
   * 这条路径是不是引用了未声明的数据项。
   *
   * 绑定表里的标红和右栏的问题清单必须来自同一份判定，否则会出现「列表里红了、
   * 体检里却说没问题」这种自相矛盾的结果。
   */
  function isUnresolved(path: string): boolean {
    return unresolved.value.some((issue) => issue.path === path)
  }

  /** 选中绑定的语法诊断；原生 JS 片段交给白名单解析器只会误报，这里不报 */
  const syntaxIssues = computed<readonly ExpressionIssue[]>(() => {
    const binding = selectedBinding.value
    if (!binding || binding.unsafe) return []
    return diagnoseExpression(binding.expression, binding.mode)
  })

  // 换过滤条件时旧下标属于另一张表，必须退回未选中，否则详情列展示不相干的绑定
  watch(selectedPath, () => {
    selectedBindingIndex.value = -1
  })

  function selectItem(path: string): void {
    selectedPath.value = selectedPath.value === path ? '' : path
  }

  function selectBinding(index: number): void {
    selectedBindingIndex.value = selectedBindingIndex.value === index ? -1 : index
  }

  /** 把画布选中集切到这条绑定的节点；页面级动作绑定没有节点可跳 */
  function locateBindingNode(): void {
    const nodeId = selectedBinding.value?.nodeId
    if (nodeId) selection.set([nodeId])
  }

  function openDataDialog(): void {
    void command.execute('pageData.openDialog')
  }

  return {
    bindings,
    groupedRows,
    isUnresolved,
    locateBindingNode,
    openDataDialog,
    refreshSource,
    rows,
    selectBinding,
    selectItem,
    selectedBinding,
    selectedBindingIndex,
    selectedLabel,
    selectedPath,
    sourceStatusText,
    sourceStatusTone,
    syntaxIssues,
    unresolved,
    unused,
    visibleBindings,
  }
}
