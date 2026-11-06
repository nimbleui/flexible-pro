import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { PageApiBinding, ProjectApi } from '@lc/schema'
import { findUnresolvedBindings } from '@lc/schema'
import { apisOfProject } from '../../../apis/api-store'
import type { PageDataStore } from './use-page-data-store'
import { validateDataName } from '../utils/data-naming'
import { bindingPatches, suggestBindingName } from '../utils/api-binding'

/**
 * 页面数据弹框里的「引用项目接口」那一块。
 *
 * 与 `useDatasourceForm` 的分工是按归属分的：那边编辑**页面自有**的数据源（地址、类型都
 * 落在文档里），这边只维护引用关系（`schema.apis`）。绑定成功后，展开出的条目会立刻进
 * `datasources`，所以画布、补全与取数不用等页面重新装载。
 */

/** 选择列表里的一行 */
export interface ProjectApiRow {
  /** 接口定义 */
  api: ProjectApi
  /** 本页已把它绑成几个数据项；同一个接口允许按不同绑定名重复引用 */
  boundCount: number
}

export function useApiBinding(store: PageDataStore) {
  const { doc, apiBindings, availableDataNames, commit } = store

  /** 接口表按 URL 上的项目段取——弹框只在项目路由下打开 */
  const projectId = String(useRoute().params.projectId)
  const projectApiList = computed(() => apisOfProject(projectId))

  const pickerOpen = ref(false)
  const bindingError = ref('')
  const unbindingName = ref<string | null>(null)
  const pendingBind = ref<{ api: ProjectApi; name: string; autoFetch: boolean } | null>(null)

  /** 当前项目登记的接口，附带本页的引用次数 */
  const projectApis = computed<readonly ProjectApiRow[]>(() =>
    projectApiList.value.map((api) => ({
      api,
      boundCount: apiBindings.value.filter((binding) => binding.apiId === api.id).length,
    })),
  )

  /** 已解析出内容的绑定；用来把列表里的条目区分成「项目接口」与「页面自有」 */
  const bindingById = computed(() => {
    const map = new Map<string, PageApiBinding>()
    for (const binding of apiBindings.value) map.set(binding.id, binding)

    return map
  })

  /** 指向已删除接口的绑定：内容展开不出来，画布上只剩一个取不到数的名字 */
  const unresolved = computed(() =>
    findUnresolvedBindings(apiBindings.value, projectApiList.value),
  )

  function isBound(id: string): boolean {
    return bindingById.value.has(id)
  }

  /** 绑定行上显示的接口名；接口被删过就直说，不留一个查不到来源的徽标 */
  function apiLabel(apiId: string): string {
    const api = projectApiList.value.find((item) => item.id === apiId)

    return api ? api.name : `接口已删除（${apiId}）`
  }

  function bindingOf(id: string): PageApiBinding | undefined {
    return bindingById.value.get(id)
  }

  /** 列表行上的接口名徽标；不是绑定时返回空串，模板据此决定要不要显示 */
  function apiLabelOf(id: string): string {
    const binding = bindingById.value.get(id)

    return binding ? apiLabel(binding.apiId) : ''
  }

  function openPicker(): void {
    bindingError.value = ''
    pendingBind.value = null
    pickerOpen.value = true
  }

  function closePicker(): void {
    pickerOpen.value = false
    pendingBind.value = null
    bindingError.value = ''
  }

  /** 选中一个接口：绑定名按接口路径给一个合法建议，用户可以改 */
  function startBind(api: ProjectApi): void {
    pendingBind.value = {
      api,
      name: suggestBindingName(api, availableDataNames(null)),
      autoFetch: true,
    }
    bindingError.value = ''
  }

  function writeBindings(next: readonly PageApiBinding[], label: string): void {
    commit(bindingPatches(doc.model.schema, next, projectApiList.value), label)
  }

  /**
   * 建立引用。
   *
   * 名字与变量、页面自有数据源共用一张占用表：`data` 只有一个命名空间，重名的后果是
   * 其中一条在写回时被剥离掉，用户看不见少了什么。
   */
  function confirmBind(): void {
    const pending = pendingBind.value
    if (!pending) return

    const name = pending.name.trim()
    const taken = new Set(availableDataNames(null))
    const error = validateDataName(name, taken, '绑定名')
    if (error !== '') {
      bindingError.value = error

      return
    }

    const binding: PageApiBinding = {
      id: name,
      apiId: pending.api.id,
      ...(pending.autoFetch ? {} : { autoFetch: false }),
    }
    writeBindings([...apiBindings.value, binding], '引用项目接口')
    closePicker()
  }

  /** 解除引用：绑定与它展开出的那条数据源一起去掉，见 `bindingPatches` */
  function unbind(id: string): void {
    writeBindings(
      apiBindings.value.filter((binding) => binding.id !== id),
      '解除接口引用',
    )
    unbindingName.value = null
  }

  return {
    pickerOpen,
    bindingError,
    unbindingName,
    pendingBind,
    projectApis,
    unresolved,
    isBound,
    apiLabel,
    apiLabelOf,
    bindingOf,
    openPicker,
    closePicker,
    startBind,
    confirmBind,
    unbind,
  }
}
