import type { Context } from '@lc/kernel'
import { manifest as canvasZoomManifest } from '@lc/canvas-plugin-zoom/manifest'
import { manifest as canvasPanManifest } from '@lc/canvas-plugin-pan/manifest'
import { manifest as canvasSelectionManifest } from '@lc/canvas-plugin-selection/manifest'
import { manifest as canvasSnapManifest } from '@lc/canvas-plugin-snap/manifest'
import { manifest as canvasDragManifest } from '@lc/canvas-plugin-drag/manifest'
import { manifest as canvasResizeManifest } from '@lc/canvas-plugin-resize/manifest'
import { manifest as canvasRotateManifest } from '@lc/canvas-plugin-rotate/manifest'
import { manifest as canvasAlignManifest } from '@lc/canvas-plugin-align/manifest'
import { manifest as canvasGuidesManifest } from '@lc/canvas-plugin-guides/manifest'
import { manifest as canvasGridManifest } from '@lc/canvas-plugin-grid/manifest'
import { manifest as canvasMinimapManifest } from '@lc/canvas-plugin-minimap/manifest'
import { manifest as canvasRulersManifest } from '@lc/canvas-plugin-rulers/manifest'
import { manifest as canvasContextMenuManifest } from '@lc/canvas-plugin-context-menu/manifest'
import { manifest as canvasCommandsManifest } from '@lc/canvas-plugin-commands/manifest'
import { manifest as canvasDropManifest } from '@lc/canvas-plugin-drop/manifest'

/**
 * 画布能力插件包：清单是纯数据，`load` 指向本模块自己的动态导入。
 *
 * `load` 在这里而不是宿主里，是这次拆分的关键——宿主内核通过 loader 拿到的
 * 是远程包的 chunk URL，插件代码因此只随画布模块部署。
 */
const CANVAS_PACKAGES = [
  { manifest: canvasZoomManifest, load: () => import('@lc/canvas-plugin-zoom') },
  { manifest: canvasPanManifest, load: () => import('@lc/canvas-plugin-pan') },
  { manifest: canvasSelectionManifest, load: () => import('@lc/canvas-plugin-selection') },
  { manifest: canvasSnapManifest, load: () => import('@lc/canvas-plugin-snap') },
  { manifest: canvasDragManifest, load: () => import('@lc/canvas-plugin-drag') },
  { manifest: canvasResizeManifest, load: () => import('@lc/canvas-plugin-resize') },
  { manifest: canvasRotateManifest, load: () => import('@lc/canvas-plugin-rotate') },
  { manifest: canvasAlignManifest, load: () => import('@lc/canvas-plugin-align') },
  { manifest: canvasDropManifest, load: () => import('@lc/canvas-plugin-drop') },
  { manifest: canvasCommandsManifest, load: () => import('@lc/canvas-plugin-commands') },
  { manifest: canvasGuidesManifest, load: () => import('@lc/canvas-plugin-guides') },
  { manifest: canvasGridManifest, load: () => import('@lc/canvas-plugin-grid') },
  { manifest: canvasRulersManifest, load: () => import('@lc/canvas-plugin-rulers') },
  { manifest: canvasMinimapManifest, load: () => import('@lc/canvas-plugin-minimap') },
  { manifest: canvasContextMenuManifest, load: () => import('@lc/canvas-plugin-context-menu') },
] as const

/**
 * 画布插件的保留服务授权。
 *
 * 平台要求「提供保留服务必须先被授权」；宿主只授予它认识的内置服务，
 * 画布侧的授权由本模块自己签发，宿主不必知道画布插件的 id。
 * 生产环境应由控制面签名后签发。
 */
const CANVAS_GRANTS: Record<string, readonly string[]> = {
  'canvas-snap': ['snap'],
}

/** 已登记过的应用上下文；同一页面的第二个宿主实例不应重复登记 */
const installedContexts = new WeakSet<Context>()

/**
 * 把画布能力插件登记进宿主内核。
 *
 * 幂等：loader 对同名插件重复登记会抛错，而画布能力是应用级注册、画布实例是
 * 文档级创建，切换文档不应重新登记。必须在 `preset-canvas` 安装之前调用——
 * 预设按 `canvasFeatures` 贡献表装配能力，晚登记的插件对本次画布不可见。
 *
 * @param context 宿主的应用根上下文
 */
export function installCanvasCapabilities(context: Context): void {
  if (installedContexts.has(context)) return
  installedContexts.add(context)

  for (const [pluginId, names] of Object.entries(CANVAS_GRANTS)) {
    context.runtime.grant(pluginId, names)
  }

  for (const pkg of CANVAS_PACKAGES) context.loader.register(pkg)
}
