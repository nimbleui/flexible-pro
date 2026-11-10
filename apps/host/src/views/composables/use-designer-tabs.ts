import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { Context } from '@lc/kernel'

/**
 * 设计器右侧与底部页签的状态、键盘导航与贡献联动。
 *
 * 右侧四个页签全集固定，底部页签随贡献增减；两者共用同一套方向键 / Home / End 导航规则，
 * 因此放在一个 composable 里，避免两份实现走偏。
 * `dockExpanded` 由 rail 持有并显式传入：点底部页签要顺手展开停靠区，这块状态不能各存一份。
 */

/**
 * 右侧面板页签；id 与 activeRightTab 取值一致，四个页签全集固定，不做动态注册。
 *
 * 页签是外壳的产品边界，内容一律来自各自的插槽：属性、样式、事件、高级各占一个槽，
 * 换掉或增装某个面板不必动外壳，也不必担心它把另外三个挤走。
 */
export interface RightTab {
  /** 页签 id，同时是 v-show 的判定值 */
  id: 'config' | 'style' | 'event' | 'advanced'
  /** 页签文案，也用于 aria-label 与键盘导航朗读 */
  label: string
}

const rightTabs: readonly RightTab[] = [
  { id: 'config', label: '页面配置' },
  { id: 'style', label: '样式' },
  { id: 'event', label: '事件' },
  { id: 'advanced', label: '高级' },
]

export interface DesignerTabsOptions {
  /** 应用级 Context；底部页签来自它的贡献注册表 */
  appCtx: Context
  /** 底部停靠区是否展开，由 rail 持有；点页签时顺手展开 */
  dockExpanded: Ref<boolean>
}

export interface DesignerTabs {
  rightTabs: readonly RightTab[]
  activeRightTab: Ref<RightTab['id']>
  /** 贡献表变更计数器；视图在 onMounted 里订阅 contribution 并自增它 */
  contributionVersion: Ref<number>
  bottomTabs: ComputedRef<readonly { id: string; label: string; icon?: string }[]>
  activeBottomPanel: ComputedRef<string | undefined>
  selectBottomTab(id: string): void
  onRightTabKeydown(event: KeyboardEvent, index: number): void
  onBottomTabKeydown(event: KeyboardEvent, index: number): void
}

export function useDesignerTabs(options: DesignerTabsOptions): DesignerTabs {
  const { appCtx, dockExpanded } = options

  const activeRightTab = ref<RightTab['id']>('config')

  /** 页签键盘导航：方向键在页签间循环，Home / End 跳到首尾 */
  function onTabKeydown(
    event: KeyboardEvent,
    index: number,
    count: number,
    select: (next: number) => void,
  ): void {
    if (
      event.key !== 'ArrowRight' &&
      event.key !== 'ArrowLeft' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return
    }

    event.preventDefault()

    const last = count - 1
    let next = index
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1
    else if (event.key === 'Home') next = 0
    else next = last

    select(next)
    const tablist = (event.currentTarget as HTMLElement | null)?.closest('[role="tablist"]')
    tablist?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }

  function onRightTabKeydown(event: KeyboardEvent, index: number): void {
    onTabKeydown(event, index, rightTabs.length, (next) => {
      activeRightTab.value = rightTabs[next].id
    })
  }

  /**
   * 底部停靠区页签；直接来自 `designer.bottomPanel` 的贡献列表。
   *
   * 页签条原先由事件流插件自己画，多一个面板就得改它的源码；改由外壳按贡献生成后，
   * 装几个面板就有几个页签，卸载即消失。id 用面板 id，与 `LcSlot` 的 `active` 同一口径。
   */
  const contributionVersion = ref(0)

  const bottomTabs = computed<readonly { id: string; label: string; icon?: string }[]>(() => {
    contributionVersion.value
    return appCtx.contribution
      .listSlot('designer.bottomPanel')
      .map((item) => ({ id: item.value.id, label: item.value.title, icon: item.value.icon }))
  })

  const activeBottomTab = ref('eventflow')

  /** 面板被卸载时回落到第一个页签：active 指向不存在的面板会让整块停靠区空白 */
  const activeBottomPanel = computed<string | undefined>(() =>
    bottomTabs.value.some((tab) => tab.id === activeBottomTab.value)
      ? activeBottomTab.value
      : bottomTabs.value[0]?.id,
  )

  /** 停靠区折叠时点页签顺手展开：页签决定「看哪个面板」，折叠按钮决定「看不看这块区域」 */
  function selectBottomTab(id: string): void {
    activeBottomTab.value = id
    dockExpanded.value = true
  }

  function onBottomTabKeydown(event: KeyboardEvent, index: number): void {
    onTabKeydown(event, index, bottomTabs.value.length, (next) => {
      const tab = bottomTabs.value[next]
      if (tab) selectBottomTab(tab.id)
    })
  }

  return {
    rightTabs,
    activeRightTab,
    contributionVersion,
    bottomTabs,
    activeBottomPanel,
    selectBottomTab,
    onRightTabKeydown,
    onBottomTabKeydown,
  }
}
