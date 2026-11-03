import { ref } from 'vue'
import type { PageRouteSchema, SchemaPatch } from '@lc/schema'
import type { PageDataStore } from './use-page-data-store'
import { formatRouteFields, parseRouteFields } from '../utils/route-fields'

/** 页面路由声明表单：params / query 两段文本与写回 `schema.route` */
export function useRouteForm(store: PageDataStore) {
  const { doc, route, commit } = store

  const routeParamsText = ref('')
  const routeQueryText = ref('')
  const routeError = ref('')

  function resetRouteDraft(): void {
    routeParamsText.value = formatRouteFields(route.value?.params)
    routeQueryText.value = formatRouteFields(route.value?.query)
    routeError.value = ''
  }

  function saveRoute(): void {
    const params = parseRouteFields(routeParamsText.value, '路径参数')
    if (typeof params === 'string') {
      routeError.value = params
      return
    }

    const query = parseRouteFields(routeQueryText.value, '查询参数')
    if (typeof query === 'string') {
      routeError.value = query
      return
    }

    const next: PageRouteSchema = {
      ...(params.fields.length > 0 ? { params: params.fields } : {}),
      ...(query.fields.length > 0 ? { query: query.fields } : {}),
    }

    const current = doc.model.schema.route
    const patch: SchemaPatch =
      params.fields.length === 0 && query.fields.length === 0
        ? { op: 'remove', path: '/route' }
        : current === undefined
          ? { op: 'add', path: '/route', value: next }
          : { op: 'replace', path: '/route', value: next }

    commit([patch], '修改页面路由声明')
    routeError.value = ''
  }

  return { routeParamsText, routeQueryText, routeError, resetRouteDraft, saveRoute }
}
