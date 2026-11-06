import type { ProjectReleaseSources } from './release-model'
import { apis } from '../apis/api-store'
import { customComponents } from '../custom-components/custom-components'
import { globalFunctions } from '../functions/global-functions'
import { pages } from '../pages/page-store'
import { flows } from '../workflows/flow-store'

/**
 * 五类资产的当前清单。
 *
 * 项目卡片计数与发布快照都要「现在这一瞬间的全量资产」，取法必须完全一致：
 * 一处读新值一处读旧值的话，卡片上写 3 张页面、快照里却装着 2 张，用户无从发现。
 *
 * 返回的是各类记录的真实类型（而不是计数用的宽松形状），因为发布侧要把页面内容
 * 原样带进快照。单独成模块而不是留在某个 store 里，是因为项目存储与发布存储都要用它，
 * 让它们各自去 import 五个资产 store 会把依赖关系铺成一张网。
 */
export function currentAssetLists(): ProjectReleaseSources {
  return {
    pages: pages.value,
    flows: flows.value,
    functions: globalFunctions.value,
    components: customComponents.value,
    apis: apis.value,
  }
}
