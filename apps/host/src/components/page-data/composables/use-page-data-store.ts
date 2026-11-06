import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { DataSourceService, DocumentService } from '@lc/contracts'
import type { Disposable } from '@lc/kernel'
import type {
  DataSourceSchemaDef,
  ExpressionEngine,
  PageApiBinding,
  PageRouteSchema,
  PageVariableSchema,
  SchemaPatch,
} from '@lc/schema'
import { arrayFieldPatch } from '@lc/schema'
import { useAppContext } from '@lc/vue'
import { functionTypeOptions, pageTypeOptions } from '../../common/type-options'
import type { EditingKey } from '../utils/data-naming'

/**
 * 页面数据弹框的共享底座：服务订阅、schema 读取与写回文档的唯一出口。
 *
 * 变量、数据源、路由三块表单都从这里取同一份 schema 与同一套写入规则，
 * 避免三处各自 `doc.apply()` 时对 patch 形态做出不同假设。
 */
export interface PageDataStore {
  doc: DocumentService
  dataSource: DataSourceService | undefined
  version: Ref<number>
  /** 数据源取数状态的变化频率高于 schema，单独一个版本号，避免每次取数重建整棵列表 */
  sourceVersion: Ref<number>
  variables: ComputedRef<readonly PageVariableSchema[]>
  datasources: ComputedRef<readonly DataSourceSchemaDef[]>
  /** 页面已建立的项目接口绑定；条目内容在 `datasources` 里已展开，这里只存引用关系 */
  apiBindings: ComputedRef<readonly PageApiBinding[]>
  route: ComputedRef<PageRouteSchema | undefined>
  /** 可引用的已定义类型：页面变量/接口结果 + 自定义函数形参与返回 */
  typeOptions: ComputedRef<ReturnType<typeof pageTypeOptions>>
  commit(patches: readonly SchemaPatch[], label: string): void
  /**
   * 数组字段整体写入。
   *
   * add / replace / remove 的判据在 `@lc/schema` 的 `arrayFieldPatch` 里，接口绑定那条路
   * 直接用同一个函数，两处不会走出两套「空数组要不要留键」的规则。
   */
  writeArray(
    key: 'variables' | 'datasources' | 'apis',
    current: readonly unknown[] | undefined,
    next: readonly unknown[],
    label: string,
  ): void
  /** 已被变量与数据源占用的名字，用于重名校验；编辑时排除自身 */
  availableDataNames(exclude: EditingKey): Set<string>
  sourceState(id: string): ReturnType<DataSourceService['stateOf']>
}

export function usePageDataStore(): PageDataStore {
  const ctx = useAppContext()
  const doc = ctx.require<DocumentService>('document')
  const dataSource = ctx.get<DataSourceService>('dataSource')
  const expression = ctx.get<ExpressionEngine>('expression')

  const version = ref(0)
  const sourceVersion = ref(0)
  let off: Disposable | null = null
  let offSource: Disposable | null = null

  onMounted(() => {
    off = doc.onDidChange(() => {
      version.value += 1
    })
    if (dataSource) {
      offSource = dataSource.onDidChange(() => {
        sourceVersion.value += 1
      })
    }
  })

  onUnmounted(() => {
    off?.dispose()
    off = null
    offSource?.dispose()
    offSource = null
  })

  const variables = computed<readonly PageVariableSchema[]>(() => {
    version.value
    return doc.model.schema.variables ?? []
  })

  const datasources = computed<readonly DataSourceSchemaDef[]>(() => {
    version.value
    return doc.model.schema.datasources ?? []
  })

  const apiBindings = computed<readonly PageApiBinding[]>(() => {
    version.value
    return doc.model.schema.apis ?? []
  })

  const route = computed<PageRouteSchema | undefined>(() => {
    version.value
    return doc.model.schema.route
  })

  const typeOptions = computed(() => {
    version.value
    const schema = doc.model.schema
    return [
      ...pageTypeOptions(schema),
      ...functionTypeOptions(expression?.functions.describe() ?? []),
    ]
  })

  function commit(patches: readonly SchemaPatch[], label: string): void {
    doc.apply(patches, { record: true, label })
  }

  /** 数组字段统一走这里：一次改动一条历史记录 */
  function writeArray(
    key: 'variables' | 'datasources' | 'apis',
    current: readonly unknown[] | undefined,
    next: readonly unknown[],
    label: string,
  ): void {
    commit([arrayFieldPatch(key, current, next)], label)
  }

  function availableDataNames(excludeVariable: EditingKey): Set<string> {
    const names = new Set<string>()
    variables.value.forEach((item, index) => {
      if (index !== excludeVariable) names.add(item.name)
    })
    for (const source of datasources.value) names.add(source.id)
    return names
  }

  function sourceState(id: string): ReturnType<DataSourceService['stateOf']> {
    sourceVersion.value
    return dataSource?.stateOf(id)
  }

  return {
    doc,
    dataSource,
    version,
    sourceVersion,
    variables,
    datasources,
    apiBindings,
    route,
    typeOptions,
    commit,
    writeArray,
    availableDataNames,
    sourceState,
  }
}
