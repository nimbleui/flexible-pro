<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type {
  CanvasRealm,
  CanvasService,
  CommandService,
  DocumentService,
  EditorRealm,
  HistoryService,
} from '@lc/contracts'
import type { ExpressionEngine, FunctionRegistration, FunctionSchema } from '@lc/schema'
import { ContextScope, LcIcon, LcSlot, useAppContext } from '@lc/vue'
import { LcDevtools } from '@lc/devtools'
import { CanvasModule } from '../canvasRemote'
import ToolbarStock from '../components/ToolbarStock.vue'
import StatusBar from '../components/StatusBar.vue'
import CommandPalette from '../components/CommandPalette.vue'
import OverlayPanel from '../components/OverlayPanel.vue'
import PageFunctionDialog from '../components/functions/PageFunctionDialog.vue'
import PageDataDialog from '../components/page-data'
import { loadSchemaWithApis } from '../apis/api-load'
import { requestDefaultsOf } from '../apis/api-config'
import { getPage, savePageSchema } from '../pages/page-store'
import { visibleInProject } from '../projects/project-model'
import { projectPath } from '../projects/project-path'
import { toastService } from '../toast'

const appCtx = useAppContext()
const route = useRoute()
const router = useRouter()
const projectId = String(route.params.projectId)
const documentId = String(route.params.documentId)
const page = visibleInProject(getPage(documentId), projectId)
/** 标题只存在页面记录里：Realm 契约不回带它，工具栏与提示文案都用这一个值 */
const pageTitle = page?.title ?? documentId

/**
 * 预览走同应用内的项目内路径，不用 `window.open`：两个视图共用同一个文档
 * Realm，设计到一半、还没点保存时也能立刻看到真实渲染；整页导航会重建应用并丢掉这份
 * 内存态，预览就只剩页面记录里已保存的内容。
 */
function openPreview(): void {
  void router.push(projectPath(projectId, `preview/${encodeURIComponent(documentId)}`))
}

/**
 * 注入画布的宿主路由作用域。
 *
 * 画布只负责页面数据（data/page），路由值由宿主提供；这样同一个画布模块
 * 既能被设计器装载，也能被预览/运行时装载，而不用自己依赖 vue-router。
 */
const routeScope = computed<Record<string, unknown>>(() => {
  const params = { ...route.params }
  const query = { ...route.query }
  return {
    $params: params,
    $query: query,
    $route: {
      path: route.path,
      fullPath: route.fullPath,
      name: typeof route.name === 'string' ? route.name : null,
      hash: route.hash,
      params,
      query,
    },
  }
})

// 重复进入同一文档复用已开的 Realm：workspace 对重复 documentId 直接抛错
const editor: EditorRealm =
  appCtx.workspace.getEditor(documentId) ??
  appCtx.workspace.createEditorRealm({
    documentId,
    title: pageTitle,
    // 项目接口在进 Realm 前展开；保存时由 page-store 剥回去，落盘的文档只留绑定
    schema: loadSchemaWithApis(page?.schema, projectId),
    requestDefaults: requestDefaultsOf(projectId),
  })

// 一篇文档可以有多个画布视图，所以画布 Realm 随视图创建、随视图释放
const canvas: CanvasRealm = editor.createCanvasRealm()

// 调试入口跟随视图：__lc.canvas 始终指向当前活动画布，production 下 __lc 未挂载即为 no-op
if (window.__lc) window.__lc.canvas = canvas

/** 工具栏订阅的画布 / 命令 / 历史服务；就绪前保持 null，按钮按不可用处理 */
const canvasService = shallowRef<CanvasService | null>(null)
const commandService = shallowRef<CommandService | null>(null)
const historyService = shallowRef<HistoryService | null>(null)

const version = ref(0)
const disposables: Array<{
  /** 释放该条订阅；卸载时按注册逆序调用，重复调用由注册方保证幂等 */
  dispose(): void
}> = []
let unmounted = false

/** 文档服务句柄：保存要把画布内存里的 schema 写回页面记录 */
const documentService = shallowRef<DocumentService | null>(null)

/** 画布当前版本与最后一次写回记录的版本；相等即没有未保存的改动 */
const docVersion = shallowRef(0)
const savedVersion = shallowRef(0)

/**
 * 是否有未保存改动。
 *
 * 判据用版本而不是 `model.dirty`：后者由文档服务在正式提交时置位，但本视图没有
 * 「写回后清脏」的入口，保存完它仍然是 true。版本两边对齐才能立刻回到已保存态。
 */
const isDirty = computed(() => docVersion.value !== savedVersion.value)

/** 页面函数弹框；由物料面板点击「自定义函数」触发 */
const pageFunctionDialogOpen = ref(false)

/** 页面数据弹框；由物料面板点击「页面数据」触发 */
const pageDataDialogOpen = ref(false)

/** 当前文档的页面函数注册；切文档 / 关闭视图时整体注销 */
let pageFunctionRegistration: FunctionRegistration = { dispose: () => {} }

/** 上一次注册的数组引用：拖拽预览也会触发文档变更，靠它跳过与函数无关的改动 */
let registeredPageFunctions: readonly FunctionSchema[] | undefined

const bump = (): void => {
  version.value += 1
}

onUnmounted(() => {
  unmounted = true
  pageFunctionRegistration.dispose()
  for (const disposable of disposables.splice(0)) disposable.dispose()
  canvas.dispose()
  if (window.__lc?.canvas === canvas) window.__lc.canvas = undefined
})

/**
 * 服务就绪门。
 *
 * `plugin()` 只做登记，canvas-core 之类要等运行时微任务批里才 apply；
 * 状态栏与舞台在 setup 阶段就 `require` 服务，所以先等一次空闲再渲染。
 */
const ready = shallowRef(false)

/**
 * 页面函数注册与文档变更联动。
 *
 * 必须早于画布挂载：CanvasStage 在 ready 之后才创建，先注册的话首次渲染就能
 * 解析到本页函数，不必等一次无关的文档变更。
 * 只比较 `schema.functions` 的数组引用——拖拽预览同样会触发文档变更，
 * 逐次重注册会让引擎反复编译同一批函数。
 */
function watchPageFunctions(
  documentService: DocumentService,
  expression: ExpressionEngine,
): void {
  const sync = (): void => {
    const next = documentService.model.schema.functions
    if (next === registeredPageFunctions) return

    registeredPageFunctions = next
    pageFunctionRegistration.dispose()
    pageFunctionRegistration = expression.functions.registerAll(next ?? [], 'page')
  }

  sync()
  disposables.push(documentService.onDidChange(sync))
}

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

/** 视口变化刷新缩放读数；命令 / 历史变化刷新撤销与重做的可用态 */
function subscribeRefreshSignals(canvasApi: CanvasService): void {
  disposables.push(canvasApi.viewport.onDidChange(bump))
  if (commandService.value) disposables.push(commandService.value.onDidChange(bump))
  if (historyService.value) disposables.push(historyService.value.onDidChange(bump))
}

onMounted(async () => {
  await appCtx.runtime.whenIdle()
  // 等待期间用户可能已经离开：此时 Realm 已释放，不能再访问服务
  if (unmounted) return

  canvasService.value = canvas.context.require<CanvasService>('canvas')
  commandService.value = canvas.context.get<CommandService>('command') ?? null
  historyService.value = editor.context.get<HistoryService>('history') ?? null

  const document = editor.context.require<DocumentService>('document')
  documentService.value = document
  // 热更新复用了已有 Realm 时起始版本可能不是 0：两边对齐才不会一进来就显示未保存
  savedVersion.value = document.model.version
  docVersion.value = savedVersion.value

  disposables.push(
    document.onDidChange((model) => {
      docVersion.value = model.version
    }),
  )

  watchPageFunctions(document, editor.context.require<ExpressionEngine>('expression'))
  registerDialogCommands()
  subscribeRefreshSignals(canvasService.value)

  // 底部页签条跟着贡献走：安装 / 卸载面板插件不必刷新页面就能增减页签
  disposables.push(
    appCtx.contribution.onDidChange(() => {
      contributionVersion.value += 1
    }),
  )

  ready.value = true
})

function commandEnabled(id: string): boolean {
  const command = commandService.value?.get(id)
  return command ? (command.enabled?.() ?? true) : false
}

const zoomLabel = computed(() => {
  version.value
  const service = canvasService.value
  return service ? `${Math.round(service.viewport.state.zoom * 100)}%` : '—'
})

const canUndo = computed(() => {
  version.value
  return commandEnabled('canvas.undo')
})

const canRedo = computed(() => {
  version.value
  return commandEnabled('canvas.redo')
})

const undoTitle = computed(() =>
  canUndo.value
    ? '撤销（Ctrl/Cmd+Z）'
    : '撤销（Ctrl/Cmd+Z）：暂无可撤销操作，或画布命令尚未就绪',
)

const redoTitle = computed(() =>
  canRedo.value
    ? '重做（Ctrl/Cmd+Shift+Z）'
    : '重做（Ctrl/Cmd+Shift+Z）：暂无可重做操作，或画布命令尚未就绪',
)

function runCommand(id: string): void {
  void commandService.value?.execute(id)
}

/**
 * 把画布内存里的文档写回页面记录。
 *
 * 只替换文档：标题与归属各有唯一写入方（页面列表的重命名、后续的项目移动）。
 * 页面在别处被删掉时 store 抛「页面不存在」，这里原样透成提示——静默丢弃改动
 * 会让人以为已经存上了。
 */
function save(): void {
  const document = documentService.value
  if (!document) return

  try {
    savePageSchema(documentId, document.model.schema, projectId)
    savedVersion.value = document.model.version
    docVersion.value = savedVersion.value
    toastService.show(`页面「${pageTitle}」已保存`, 'success')
  } catch (cause) {
    toastService.show(cause instanceof Error ? cause.message : String(cause), 'error')
  }
}

/** 浮动面板的标题；rail 项与浮层头部共用同一个字符串，不在两处各写一遍 */
const OVERLAY_TITLE = '页面大纲'

/** rail 上可开关的界面；面板可见性归外壳，内容归贡献该槽的插件 */
type RailTarget = 'leftPanel' | 'overlayPanel' | 'dock'

interface DesignerRailItem {
  /** 稳定 id，用于 key 与 aria 定位 */
  id: string
  /** 图标下方的短标签 */
  label: string
  /** 共享图标注册表里的图标名 */
  icon: string
  /**
   * 点击行为；undefined 渲染成禁用态，提示尚未接入。
   *
   * 命令型复用宿主已注册的命令（页面数据 / 自定义函数弹框），不新造一套开关状态。
   */
  action?: { kind: 'toggle'; target: RailTarget } | { kind: 'command'; commandId: string }
}

// rail 是工作区入口集合：组件库常驻左栏，页面大纲浮在画布上，底部面板开关停靠区
const railItems: readonly DesignerRailItem[] = [
  {
    id: 'components',
    label: '组件库',
    icon: 'library',
    action: { kind: 'toggle', target: 'leftPanel' },
  },
  {
    id: 'outline',
    label: OVERLAY_TITLE,
    icon: 'outline',
    action: { kind: 'toggle', target: 'overlayPanel' },
  },
  {
    id: 'dataSource',
    label: '数据源',
    icon: 'database',
    action: { kind: 'command', commandId: 'pageData.openDialog' },
  },
  {
    id: 'functions',
    label: '方法管理',
    icon: 'function',
    action: { kind: 'command', commandId: 'pageFunction.openDialog' },
  },
  {
    id: 'dock',
    label: '底部面板',
    icon: 'list',
    action: { kind: 'toggle', target: 'dock' },
  },
  { id: 'versions', label: '版本管理', icon: 'version' },
  { id: 'settings', label: '设置', icon: 'sliders' },
]

/** 左侧常驻面板、浮动大纲面板与底部停靠区的可见性；三者互不排斥，可以同屏 */
const leftPanelOpen = ref(true)
const overlayOpen = ref(false)
const dockExpanded = ref(true)

/** rail 项的按下态；命令型按钮没有可保持的状态，返回 undefined 让 Vue 不写 aria-pressed */
function railPressed(item: DesignerRailItem): boolean | undefined {
  const action = item.action
  if (!action || action.kind === 'command') return undefined
  if (action.target === 'leftPanel') return leftPanelOpen.value
  if (action.target === 'overlayPanel') return overlayOpen.value
  return dockExpanded.value
}

function onRailClick(item: DesignerRailItem): void {
  const action = item.action
  if (!action) return

  if (action.kind === 'command') {
    runCommand(action.commandId)
    return
  }

  if (action.target === 'leftPanel') leftPanelOpen.value = !leftPanelOpen.value
  else if (action.target === 'overlayPanel') overlayOpen.value = !overlayOpen.value
  else dockExpanded.value = !dockExpanded.value
}

type DeviceKind = 'desktop' | 'tablet' | 'mobile'

/** 预览设备档位；顺序即切换器展示顺序，与 DeviceKind 全集一致 */
const devices: ReadonlyArray<{
  /** 档位 id，写入 activeDevice 供模板比较 */
  id: DeviceKind
  /** 档位展示名 */
  label: string
}> = [
  { id: 'desktop', label: '桌面' },
  { id: 'tablet', label: '平板' },
  { id: 'mobile', label: '手机' },
]

const activeDevice = ref<DeviceKind>('desktop')

/**
 * 右侧面板页签；id 与 activeRightTab 取值一致，四个页签全集固定，不做动态注册。
 *
 * 页签是外壳的产品边界，内容一律来自各自的插槽：属性、样式、事件、高级各占一个槽，
 * 换掉或增装某个面板不必动外壳，也不必担心它把另外三个挤走。
 */
interface RightTab {
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

const devtoolsOpen = shallowRef(false)
</script>

<template>
  <div v-if="!ready" class="lc-designer__loading">文档装载中…</div>

  <ContextScope v-else :context="editor.context">
    <div class="lc-designer">
      <div class="lc-designer__toolbar" role="toolbar" aria-label="设计器工具条">
        <nav class="lc-designer__crumbs" aria-label="当前位置">
          <span class="lc-designer__crumb">低代码运营大屏</span>
          <span class="lc-designer__crumb-sep" aria-hidden="true">/</span>
          <span class="lc-designer__crumb lc-designer__crumb--current">{{ documentId }}</span>
        </nav>

        <span class="lc-designer__divider" aria-hidden="true" />

        <div class="lc-designer__group">
          <button
            type="button"
            class="lc-icon-button"
            aria-label="撤销"
            :title="undoTitle"
            :disabled="!canUndo"
            @click="runCommand('canvas.undo')"
          >
            <span aria-hidden="true">↺</span>
          </button>
          <button
            type="button"
            class="lc-icon-button"
            aria-label="重做"
            :title="redoTitle"
            :disabled="!canRedo"
            @click="runCommand('canvas.redo')"
          >
            <span aria-hidden="true">↻</span>
          </button>
        </div>

        <span class="lc-designer__divider" aria-hidden="true" />

        <span
          class="lc-designer__zoom"
          :aria-label="`画布缩放 ${zoomLabel}`"
          title="画布缩放比例（只读，使用画布快捷键调整）"
        >
          {{ zoomLabel }}
        </span>

        <span class="lc-designer__divider" aria-hidden="true" />

        <div class="lc-device-switch" role="group" aria-label="设备预览">
          <button
            v-for="device in devices"
            :key="device.id"
            type="button"
            class="lc-device-switch__button"
            :aria-pressed="activeDevice === device.id"
            :aria-label="`${device.label}预览`"
            :title="`${device.label}（断点渲染尚未接入）`"
            @click="activeDevice = device.id"
          >
            <span
              class="lc-device-switch__glyph"
              :class="`lc-device-switch__glyph--${device.id}`"
              aria-hidden="true"
            />
          </button>
        </div>

        <span class="lc-designer__divider" aria-hidden="true" />

        <!-- 插件贡献的画布命令继续由 ToolbarStock 渲染，外壳只负责给它一条滚动带 -->
        <div class="lc-designer__plugins">
          <ToolbarStock />
        </div>

        <div class="lc-designer__actions">
          <button
            type="button"
            class="lc-designer__action"
            title="预览当前文档（与设计器共用内存中的文档，无需先保存）"
            @click="openPreview"
          >
            预览
          </button>
          <button
            type="button"
            class="lc-designer__action"
            :disabled="!isDirty || !documentService"
            :title="isDirty ? '把画布当前文档写回页面记录' : '文档没有未保存的改动'"
            @click="save"
          >
            保存
          </button>
          <button
            type="button"
            class="lc-designer__action lc-designer__action--primary"
            disabled
            title="发布尚未接入"
          >
            发布
          </button>

          <span class="lc-designer__divider" aria-hidden="true" />

          <button
            type="button"
            class="lc-icon-button"
            :aria-pressed="devtoolsOpen"
            aria-label="开发者工具"
            title="开发者工具"
            @click="devtoolsOpen = !devtoolsOpen"
          >
            <span class="lc-designer__devtools-glyph" aria-hidden="true">{ }</span>
          </button>
        </div>
      </div>

      <div class="lc-designer__body">
        <nav class="lc-rail" aria-label="设计器工作区">
          <button
            v-for="item in railItems"
            :key="item.id"
            type="button"
            class="lc-rail__item"
            :class="{ 'lc-rail__item--active': railPressed(item) === true }"
            :disabled="!item.action"
            :aria-label="item.label"
            :aria-pressed="railPressed(item)"
            :title="item.action ? item.label : `${item.label}（尚未接入）`"
            @click="onRailClick(item)"
          >
            <LcIcon :name="item.icon" :size="18" />
            <span aria-hidden="true">{{ item.label }}</span>
          </button>
        </nav>

        <!-- 标题与搜索由面板自己提供：外壳再画一遍会和面板头部叠成两行，与底部 dock 同一约定 -->
        <aside
          v-show="leftPanelOpen"
          class="lc-designer__panel lc-designer__panel--left"
          aria-label="组件库"
        >
          <div class="lc-designer__panel-body">
            <LcSlot name="designer.leftPanel" :context="{ documentId }">
              <template #empty>
                <div class="lc-app__empty lc-designer__panel-empty">暂无面板贡献</div>
              </template>
            </LcSlot>
          </div>
        </aside>

        <section class="lc-designer__center">
          <div class="lc-designer__stage">
            <CanvasModule
              :app-context="appCtx"
              :canvas-context="canvas.context"
              :scope="routeScope"
            />
            <!-- 浮动大纲面板：盖在画布上，关掉它不影响属性面板与底部事件流 -->
            <OverlayPanel
              v-show="overlayOpen"
              :title="OVERLAY_TITLE"
              slot-name="designer.overlayPanel"
              :context="{ documentId }"
              @close="overlayOpen = false"
            />
          </div>

          <section
            class="lc-dock"
            :class="{ 'lc-dock--collapsed': !dockExpanded }"
            aria-label="底部面板"
          >
            <!--
              页签条由外壳按 designer.bottomPanel 的贡献生成：面板插件只声明自己，
              不必再互相借用某一家的页签条，卸载后页签也随之消失。
            -->
            <header class="lc-dock__header">
              <nav
                v-if="bottomTabs.length"
                class="lc-dock__tabs"
                role="tablist"
                aria-label="底部面板页签"
              >
                <button
                  v-for="(tab, index) in bottomTabs"
                  :id="`lc-dock-tab-${tab.id}`"
                  :key="tab.id"
                  type="button"
                  role="tab"
                  class="lc-dock__tab"
                  :aria-selected="activeBottomPanel === tab.id"
                  aria-controls="lc-dock-panel"
                  :tabindex="activeBottomPanel === tab.id ? 0 : -1"
                  @click="selectBottomTab(tab.id)"
                  @keydown="onBottomTabKeydown($event, index)"
                >
                  <LcIcon v-if="tab.icon" :name="tab.icon" :size="12" />
                  {{ tab.label }}
                </button>
              </nav>

              <button
                type="button"
                class="lc-dock__toggle"
                :aria-expanded="dockExpanded"
                aria-controls="lc-dock-panel"
                :aria-label="dockExpanded ? '折叠底部面板' : '展开底部面板'"
                :title="dockExpanded ? '折叠底部面板' : '展开底部面板'"
                @click="dockExpanded = !dockExpanded"
              >
                <span
                  class="lc-dock__chevron"
                  :class="{ 'lc-dock__chevron--up': dockExpanded }"
                  aria-hidden="true"
                />
              </button>
            </header>

            <!-- 停靠区内容完全由插件通过 designer.bottomPanel 提供，外壳只切换当前页签 -->
            <div
              v-show="dockExpanded"
              id="lc-dock-panel"
              class="lc-dock__body"
              role="tabpanel"
              :aria-labelledby="
                activeBottomPanel ? `lc-dock-tab-${activeBottomPanel}` : undefined
              "
            >
              <LcSlot
                name="designer.bottomPanel"
                :active="activeBottomPanel"
                :context="{ documentId }"
              >
                <template #empty>
                  <div class="lc-dock__empty">
                    <span class="lc-dock__empty-title">底部面板尚未接入</span>
                    <span
                      >安装面板插件后，其内容会通过 designer.bottomPanel 插槽挂载在这里。</span
                    >
                  </div>
                </template>
              </LcSlot>
            </div>
          </section>
        </section>

        <aside class="lc-designer__panel lc-designer__panel--right" aria-label="属性面板">
          <div class="lc-designer__tabs" role="tablist" aria-label="属性面板页签">
            <button
              v-for="(tab, index) in rightTabs"
              :id="`lc-tab-${tab.id}`"
              :key="tab.id"
              type="button"
              role="tab"
              class="lc-designer__tab"
              :aria-selected="activeRightTab === tab.id"
              :aria-controls="`lc-tabpanel-${tab.id}`"
              :tabindex="activeRightTab === tab.id ? 0 : -1"
              @click="activeRightTab = tab.id"
              @keydown="onRightTabKeydown($event, index)"
            >
              {{ tab.label }}
            </button>
          </div>

          <div
            v-show="activeRightTab === 'config'"
            id="lc-tabpanel-config"
            class="lc-designer__tabpanel"
            role="tabpanel"
            aria-labelledby="lc-tab-config"
          >
            <LcSlot name="designer.rightPanel" :context="{ documentId }">
              <template #empty>
                <div class="lc-app__empty">暂无属性面板</div>
              </template>
            </LcSlot>
          </div>

          <div
            v-show="activeRightTab === 'style'"
            id="lc-tabpanel-style"
            class="lc-designer__tabpanel"
            role="tabpanel"
            aria-labelledby="lc-tab-style"
          >
            <LcSlot name="designer.stylePanel" :context="{ documentId }">
              <template #empty>
                <p class="lc-designer__placeholder">样式面板尚未安装</p>
              </template>
            </LcSlot>
          </div>

          <div
            v-show="activeRightTab === 'event'"
            id="lc-tabpanel-event"
            class="lc-designer__tabpanel"
            role="tabpanel"
            aria-labelledby="lc-tab-event"
          >
            <LcSlot name="designer.eventPanel" :context="{ documentId }">
              <template #empty>
                <p class="lc-designer__placeholder">事件面板尚未安装</p>
              </template>
            </LcSlot>
          </div>

          <div
            v-show="activeRightTab === 'advanced'"
            id="lc-tabpanel-advanced"
            class="lc-designer__tabpanel"
            role="tabpanel"
            aria-labelledby="lc-tab-advanced"
          >
            <LcSlot name="designer.advancedPanel" :context="{ documentId }">
              <template #empty>
                <p class="lc-designer__placeholder">高级面板尚未安装</p>
              </template>
            </LcSlot>
          </div>
        </aside>

        <LcDevtools
          v-if="devtoolsOpen"
          class="lc-app__devtools"
          :context="appCtx"
          :canvas-context="canvas.context"
          @close="devtoolsOpen = false"
        />
      </div>

      <StatusBar :canvas-context="canvas.context" />
    </div>

    <!-- 命令面板需要文档级服务（选中/文档），因此挂在编辑器作用域内而不是外壳里 -->
    <CommandPalette />

    <!-- 页面函数弹框直接写当前文档 schema，同样需要文档级服务 -->
    <PageFunctionDialog
      :open="pageFunctionDialogOpen"
      @close="pageFunctionDialogOpen = false"
    />

    <!-- 页面数据同样写入当前文档 schema -->
    <PageDataDialog :open="pageDataDialogOpen" @close="pageDataDialogOpen = false" />
  </ContextScope>
</template>
