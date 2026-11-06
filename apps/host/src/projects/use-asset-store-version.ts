import { onScopeDispose, ref } from 'vue'
import { onApisChange } from '../apis/api-store'
import { onCustomComponentsChange } from '../custom-components/custom-components'
import { onGlobalFunctionsChange } from '../functions/global-functions'
import { onPagesChange } from '../pages/page-store'
import { onFlowsChange } from '../workflows/flow-store'

/**
 * 五类资产存储的变更计数。
 *
 * 五个 store 都是模块级 `shallowRef` + 各自的通知集合，没有共同的事件总线可挂，
 * 想「资产一变就重算」只能逐个订阅。项目卡片与项目内页签都要这件事，
 * 抽出来一次，注销也只需写一处。
 *
 * 返回值只用来建立依赖：读一次 `version.value`，之后的重算就会跟着任何一次
 * 资产增删改走；计数本身交给 `countAssetsOf`，不在这里重复一遍过滤规则。
 */
export function useAssetStoreVersion() {
  const version = ref(0)

  const bump = (): void => {
    version.value += 1
  }

  const disposables = [
    onPagesChange(bump),
    onFlowsChange(bump),
    onGlobalFunctionsChange(bump),
    onCustomComponentsChange(bump),
    onApisChange(bump),
  ]

  // 订阅挂在 effect scope 上：组件卸载或外层作用域销毁都会回收
  onScopeDispose(() => {
    for (const disposable of disposables.splice(0)) disposable.dispose()
  })

  return version
}
