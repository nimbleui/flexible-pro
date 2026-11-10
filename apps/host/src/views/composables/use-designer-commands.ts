import type { Ref } from 'vue'
import type { CommandService, VersionHostService, VersionPanelSection } from '@lc/contracts'
import type { Context } from '@lc/kernel'
import { toastService } from '../../toast'

/**
 * 设计器视图注册的两组命令：物料面板弹框入口与版本面板命令。
 *
 * 命令只广播意图、不直接操作面板内部状态：面板由插槽懒加载，命令执行时它可能还没挂载。
 * 注册所得句柄统一交给视图的 disposables，在卸载时按注册逆序释放。
 *
 * 依赖全部显式传入，composable 不自行读取视图状态：服务句柄要到 onMounted 才就绪，
 * 这里不能在 setup 期把它们当成已存在的值。
 */

/** 视图统一在卸载时释放的订阅 / 注册句柄；与视图登记处结构一致 */
interface Subscription {
  dispose(): void
}

export interface DesignerCommandsOptions {
  /** 应用级 Context；取版本宿主服务、注册快捷键并广播版本事件 */
  appCtx: Context
  /** 当前项目 id；提交版本时用它取会话 */
  projectId: string
  /** 命令服务句柄；就绪前为 null，注册函数自行判空 */
  commandService: Ref<CommandService | null>
  /** 视图的订阅登记处；注册句柄追加进来，卸载时统一释放 */
  disposables: Subscription[]
  /** 页面函数弹框开关 */
  pageFunctionDialogOpen: Ref<boolean>
  /** 页面数据弹框开关 */
  pageDataDialogOpen: Ref<boolean>
  /** 展开底部 dock 并切到指定页签；版本面板由插槽懒加载 */
  selectBottomTab: (id: string) => void
}

export interface DesignerCommands {
  /** 注册物料面板里的「自定义函数」「页面数据」两条弹框命令 */
  registerDialogCommands(): void
  /** 注册版本提交命令、五个分区导航命令与两条快捷键 */
  registerVersionCommands(): void
}

export function useDesignerCommands(options: DesignerCommandsOptions): DesignerCommands {
  const {
    appCtx,
    projectId,
    commandService,
    disposables,
    pageFunctionDialogOpen,
    pageDataDialogOpen,
    selectBottomTab,
  } = options

  /** 物料面板里的「自定义函数」「页面数据」是纯入口物料，点击后执行这两条命令打开弹框 */
  function registerDialogCommands(): void {
    const service = commandService.value
    if (!service) return

    disposables.push(
      service.register({
        id: 'pageFunction.openDialog',
        title: '添加自定义函数',
        run: () => {
          pageFunctionDialogOpen.value = true
        },
      }),
      service.register({
        id: 'pageData.openDialog',
        title: '编辑页面数据',
        run: () => {
          pageDataDialogOpen.value = true
        },
      }),
    )
  }

  /**
   * 打开版本面板并聚焦指定分区。
   *
   * 命令只广播意图，不直接操作面板内部状态：面板由插槽懒加载，命令执行时它可能还没
   * 挂载。`selectBottomTab` 负责展开 dock 与切页签，`version:open` 由面板自己订阅。
   */
  function openVersionPanel(section: VersionPanelSection, previewTarget?: string): void {
    selectBottomTab('version')
    appCtx.emit('version:open', { section, previewTarget })
  }

  /**
   * 注册版本命令与快捷键。
   *
   * 只有 `version.commit` 直接执行写操作：它没有参数、内容不变时不产生提交，是唯一
   * 适合从命令面板 / 快捷键无确认触发的动作。其余命令打开对应分区让用户选目标，
   * 因为切分支、合并、发布、回滚都需要参数或不可逆确认，盲目执行等于埋误操作。
   * 快捷键刻意不用 `Mod+S`：灰度期保留浏览器与既有保存路径的语义，不抢用户习惯。
   */
  function registerVersionCommands(): void {
    const service = commandService.value
    if (!service) return

    const host = appCtx.get<VersionHostService>('version')
    const open = (section: VersionPanelSection): void => openVersionPanel(section)

    disposables.push(
      service.register({
        id: 'version.commit',
        title: '提交版本',
        run: async () => {
          if (!host || host.mode === 'off') {
            toastService.show('版本控制未启用（VITE_LC_VERSION_MODE=off）', 'error')
            return
          }

          try {
            const session = await host.session(projectId)
            if (!session) {
              toastService.show('版本库会话不可用', 'error')
              return
            }

            const created = await session.commit({ message: '命令提交' })
            toastService.show(
              created ? `已提交 ${created.id.slice(0, 8)}` : '内容未变化，未产生新提交',
              'success',
            )
          } catch (cause) {
            toastService.show(cause instanceof Error ? cause.message : String(cause), 'error')
          }
        },
      }),
    )

    const navigationCommands: ReadonlyArray<{
      id: string
      title: string
      section: VersionPanelSection
    }> = [
      { id: 'version.openHistory', title: '打开版本历史', section: 'history' },
      { id: 'version.checkout', title: '切换版本分支', section: 'branches' },
      { id: 'version.merge', title: '合并版本', section: 'conflicts' },
      { id: 'version.publish', title: '发布版本', section: 'releases' },
      { id: 'version.rollback', title: '回滚版本', section: 'releases' },
    ]

    for (const entry of navigationCommands) {
      disposables.push(
        service.register({
          id: entry.id,
          title: entry.title,
          run: () => open(entry.section),
        }),
      )
    }

    disposables.push(
      appCtx.keybinding.register({
        id: 'version.openHistory.key',
        key: 'Mod+Alt+H',
        command: 'version.openHistory',
      }),
      appCtx.keybinding.register({
        id: 'version.commit.key',
        key: 'Mod+Alt+S',
        command: 'version.commit',
      }),
    )
  }

  return { registerDialogCommands, registerVersionCommands }
}
