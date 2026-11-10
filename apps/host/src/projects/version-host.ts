import type { VersionHostService, VersionReleaseSummary } from '@lc/contracts'
import type { Context, Disposable } from '@lc/kernel'
import { definePlugin } from '@lc/kernel'
import { IdbVersionStore, parseVersionMode } from '@lc/service-version'
import { getProject } from './project-store'
import { currentAssetLists } from './project-assets'
import { collectProjectAssets } from './release-model'
import {
  checkProjectRelease,
  listReleasesOf,
  publishProject,
  setCurrentRelease,
} from './release-store'
import { createVersionBridge, type VersionBridge } from './version-bridge'
import { validateWorkingTree } from './version-validation'

/**
 * 宿主侧装配：读灰度档位、注入资产读取与对象存储，并把版本能力挂到应用 Context。
 *
 * 桥接不是「装完就丢」的旁路，而是 `version` 服务的实现。
 * 面板插件与状态栏都在别的包里，不能反向 import 宿主；Context 服务是它们与宿主
 * 资产 / IndexedDB / 发布存储之间唯一不破坏依赖方向的通道。
 *
 * `off`（含未配置、拼错）时不构造 IndexedDB、不订阅活动信号，但**仍然提供**
 * `mode === 'off'` 的服务：面板因此能明确显示「版本控制未启用」，而不是空白。
 * 这是默认状态，也是新版本出问题时最直接的回滚方式——删掉环境变量即可。
 *
 * 读资产复用既有的 `collectProjectAssets`：它与发布校验、发布快照是同一套归属解释，
 * 版本库不需要再写一份平行的项目过滤。注意该函数会把页面里的接口绑定展开成完整
 * 地址（发布视角），而 `lc.pages.v1` 存的是 `stripApiBindings` 后的草稿；检出
 * 仍是只读视图，不回写资产，因此不受影响，但未来的回写必须先做 `stripApiBindings`。
 */
export function installVersionHost(context: Context): Disposable {
  const raw: unknown = import.meta.env.VITE_LC_VERSION_MODE
  const mode = parseVersionMode(typeof raw === 'string' ? raw : undefined)

  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  let bridge: VersionBridge | undefined
  if (mode !== 'off') {
    // 一个实例按 repoId 分库；项目之间互不干扰，删库即回到「该项目未接入版本库」
    const store = new IdbVersionStore()
    bridge = createVersionBridge({
      mode,
      readAssets: (projectId) => collectProjectAssets(currentAssetLists(), projectId),
      createStore: () => store,
      validate: validateWorkingTree,
      onChange: () => notify(),
      onMismatch: (projectId, mismatches) => {
        if (mismatches.length === 0) return
        console.warn(`[host] 版本库投影与旧路径不一致 (${projectId})`, mismatches)
      },
    })
  }

  const service: VersionHostService = {
    mode,

    session(projectId) {
      return bridge?.session(projectId).then((session) => session.service)
    },

    onDidChange(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },

    releases(projectId): readonly VersionReleaseSummary[] {
      const current = getProject(projectId)?.publishedRevision
      return listReleasesOf(projectId).map((release) => ({
        revision: release.revision,
        createdAt: release.createdAt,
        current: release.revision === current,
      }))
    },

    checkRelease(projectId) {
      return checkProjectRelease(projectId)
    },

    publish(projectId) {
      const revision = publishProject(projectId).revision
      // off 档位没有活动订阅，发布区的「当前版本」标记不会自己刷新
      notify()
      return revision
    },

    rollback(projectId, revision) {
      // 回滚只移动宿主发布指针、不发版本活动信号，所以显式通知 UI
      setCurrentRelease(projectId, revision)
      notify()
    },
  }

  // 保留服务名必须走授权：用插件的 ctx 提供，授权来自 createApp 的 GRANTS。
  // ctx.effect 把 provide 的注销句柄挂到插件作用域，卸载插件即撤销服务。
  const record = context.plugin(
    definePlugin({
      name: 'host-version',
      apply(ctx) {
        ctx.effect(() => ctx.provide('version', service, { apiVersion: '1.0' }))
      },
    }),
  )

  const handle: Disposable = {
    dispose() {
      context.runtime.unload(record.id)
      bridge?.dispose()
      listeners.clear()
    },
  }

  // HMR 替换模块会重复安装订阅与服务，一次活动就会被写成两份提交
  import.meta.hot?.dispose(() => handle.dispose())

  return handle
}
