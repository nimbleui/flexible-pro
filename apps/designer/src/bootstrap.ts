import type { CanvasRealm, EditorRealm, LoaderService, WorkspaceService } from '@lc/contracts'
import { installContextServices } from '@lc/contracts'
import { createApp } from '@lc/kernel'
import type { Context } from '@lc/kernel'
import presetDesigner from '@lc/preset-designer'
import presetCanvas from '@lc/preset-canvas'
import { manifest as materialsBasicManifest } from '@lc/plugin-materials-basic/manifest'
import { manifest as outlinePanelManifest } from '@lc/plugin-panel-outline/manifest'
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
import { manifest as canvasContextMenuManifest } from '@lc/canvas-plugin-context-menu/manifest'
import { manifest as canvasRulersManifest } from '@lc/canvas-plugin-rulers/manifest'
import { manifest as canvasMinimapManifest } from '@lc/canvas-plugin-minimap/manifest'
import { createDemoSchema } from './demo-document'
import { manifest as canvasCommandsManifest } from '@lc/canvas-plugin-commands/manifest'
import { manifest as canvasDropManifest } from '@lc/canvas-plugin-drop/manifest'
import { manifest as materialsPanelManifest } from '@lc/plugin-panel-materials/manifest'
import { manifest as propertiesPanelManifest } from '@lc/plugin-panel-properties/manifest'

declare global {
  interface Window {
    /** 开发期调试入口；仅 DEV 下挂载 */
    __lc?: DesignerBootstrap
  }
}

/**
 * 平台为内置服务插件预置的保留服务授权。
 *
 * 生产环境由 loader 在签名与认证等级校验后签发；这里显式声明，
 * 保证没有控制面时也能跑通内置能力，同时保留「保留服务需要授权」的约束。
 */
const GRANTS: Record<string, readonly string[]> = {
  'service-modules': ['modules'],
  'service-loader': ['loader', 'contribution'],
  'service-material': ['material'],
  'service-command': ['command'],
  'service-renderer': ['renderer'],
  'service-setter': ['setter'],
  'service-workspace': ['workspace'],
  'service-document': ['document'],
  'service-history': ['history'],
  'service-selection': ['selection'],
  'service-canvas-core': ['canvas'],
  'canvas-snap': ['snap'],
}

/** 构建期内置的插件包清单；生产环境由 Vite 插件扫描 package.json.lowcode 生成 */
const BUILTIN_PACKAGES = [
  { manifest: materialsBasicManifest, load: () => import('@lc/plugin-materials-basic') },
  { manifest: materialsPanelManifest, load: () => import('@lc/plugin-panel-materials') },
  { manifest: outlinePanelManifest, load: () => import('@lc/plugin-panel-outline') },
  { manifest: propertiesPanelManifest, load: () => import('@lc/plugin-panel-properties') },
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

export interface DesignerBootstrap {
  /** 应用根上下文 */
  context: Context
  /** 当前文档 Realm */
  editor: EditorRealm
  /** 当前文档的画布 Realm */
  canvas: CanvasRealm
}

/**
 * 启动设计器：
 * 1. createApp → 安装 preset-designer（modules / loader / material / command / renderer / workspace）
 * 2. loader 登记内置插件包的 manifest 与模块
 * 3. workspace 打开文档 Realm
 * 4. 创建 CanvasRealm 并安装 preset-canvas（按 canvasFeatures 贡献装配）
 */
export async function bootstrapDesigner(): Promise<DesignerBootstrap> {
  // 契约层的声明合并只有在安装访问器后才能通过 ctx.material 等属性取值
  installContextServices()

  const context = createApp({ id: 'designer', grants: GRANTS })

  context.plugin(presetDesigner)
  await context.runtime.whenIdle()

  const loader = context.require<LoaderService>('loader')
  for (const pkg of BUILTIN_PACKAGES) loader.register(pkg)

  const workspace = context.require<WorkspaceService>('workspace')
  const editor = workspace.createEditorRealm({
    documentId: 'demo-doc',
    title: '示例页面',
    schema: createDemoSchema(),
  })
  await context.runtime.whenIdle()

  const canvas = editor.createCanvasRealm()
  canvas.context.plugin(presetCanvas)
  await context.runtime.whenIdle()

  // 命令面板是应用级 UI：命令本身也注册在应用级，快捷键只是入口
  context.command.register({
    id: 'app.commandPalette',
    title: '打开命令面板',
    run: () => context.emit('palette:toggle'),
  })
  context.keybinding.register({
    id: 'app.commandPalette.key',
    key: 'Mod+K',
    command: 'app.commandPalette',
  })

  const result: DesignerBootstrap = { context, editor, canvas }
  // 非生产模式都挂调试入口：vite dev 与 `vite build --mode development` 的预览包
  // 都需要能直连服务排查，只有 production 构建才彻底移除
  if (import.meta.env.MODE !== 'production') window.__lc = result
  return result
}
