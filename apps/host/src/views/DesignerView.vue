<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
} from 'vue'
import { useRoute } from 'vue-router'
import type {
  CanvasRealm,
  CanvasService,
  CommandService,
  DocumentService,
  EditorRealm,
  HistoryService,
} from '@lc/contracts'
import type { ExpressionEngine, FunctionRegistration, FunctionSchema } from '@lc/schema'
import { ContextScope, LcSlot, useAppContext } from '@lc/vue'
import { LcDevtools } from '@lc/devtools'
import ToolbarStock from '../components/ToolbarStock.vue'
import StatusBar from '../components/StatusBar.vue'
import CommandPalette from '../components/CommandPalette.vue'
import PageFunctionDialog from '../components/functions/PageFunctionDialog.vue'
import { findPage } from '../pages'

/**
 * 远程画布模块。
 *
 * 地址在运行时才由 Module Federation 解析，因此只能异步装载；远程不可达时给出
 * 可操作的提示，而不是留下一片空白让人以为画布坏了。
 */
const CanvasModule = defineAsyncComponent({
  loader: () => import('designerCanvas/CanvasModule'),
  errorComponent: defineComponent({
    setup: () => () =>
      h(
        'div',
        { class: 'lc-designer__notice' },
        '画布模块不可用：请确认 designer 已在 5174 端口启动（pnpm dev 会并行拉起两个进程）',
      ),
  }),
})

const appCtx = useAppContext()
const route = useRoute()
const documentId = String(route.params.documentId)
const page = findPage(documentId)

// 重复进入同一文档复用已开的 Realm：workspace 对重复 documentId 直接抛错
const editor: EditorRealm =
  appCtx.workspace.getEditor(documentId) ??
  appCtx.workspace.createEditorRealm({
    documentId,
    title: page?.title ?? documentId,
    schema: page?.createSchema(),
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
const disposables: Array<{ dispose(): void }> = []
let unmounted = false

/** 页面函数弹框；由物料面板点击「自定义函数」触发 */
const pageFunctionDialogOpen = ref(false)

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

onMounted(async () => {
  await appCtx.runtime.whenIdle()
  // 等待期间用户可能已经离开：此时 Realm 已释放，不能再访问服务
  if (unmounted) return

  canvasService.value = canvas.context.require<CanvasService>('canvas')
  commandService.value = canvas.context.get<CommandService>('command') ?? null
  historyService.value = editor.context.get<HistoryService>('history') ?? null

  /**
   * 页面函数先于画布挂载注册：CanvasStage 在 ready 之后才创建，
   * 首次渲染就能解析到本页函数，不必等一次无关的文档变更。
   */
  const documentService = editor.context.require<DocumentService>('document')
  const expression = editor.context.require<ExpressionEngine>('expression')

  const syncPageFunctions = (): void => {
    const next = documentService.model.schema.functions
    if (next === registeredPageFunctions) return

    registeredPageFunctions = next
    pageFunctionRegistration.dispose()
    pageFunctionRegistration = expression.functions.registerAll(next ?? [], 'page')
  }

  syncPageFunctions()
  disposables.push(documentService.onDidChange(syncPageFunctions))

  // 物料面板里的「自定义函数」是纯入口物料，点击后执行这条命令打开弹框
  if (commandService.value) {
    disposables.push(
      commandService.value.register({
        id: 'pageFunction.openDialog',
        title: '添加自定义函数',
        run: () => {
          pageFunctionDialogOpen.value = true
        },
      }),
    )
  }

  // 视口变化刷新缩放读数；命令历史变化刷新撤销 / 重做可用态
  disposables.push(canvasService.value.viewport.onDidChange(bump))
  if (commandService.value) disposables.push(commandService.value.onDidChange(bump))
  if (historyService.value) disposables.push(historyService.value.onDidChange(bump))

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

interface DesignerRailItem {
  id: string
  label: string
  glyph: string
  available: boolean
}

// 图标栏是工作区切换器：当前只有组件库可用，其余入口先占位
const activeRailId = 'components'

const railItems: readonly DesignerRailItem[] = [
  { id: 'components', label: '组件', glyph: '▦', available: true },
  { id: 'templates', label: '模板', glyph: '▤', available: false },
  { id: 'assets', label: '资源', glyph: '◈', available: false },
  { id: 'plugins', label: '插件', glyph: '⬡', available: false },
  { id: 'ai', label: 'AI', glyph: '✦', available: false },
]

type DeviceKind = 'desktop' | 'tablet' | 'mobile'

const devices: ReadonlyArray<{ id: DeviceKind; label: string }> = [
  { id: 'desktop', label: '桌面' },
  { id: 'tablet', label: '平板' },
  { id: 'mobile', label: '手机' },
]

const activeDevice = ref<DeviceKind>('desktop')

interface RightTab {
  id: 'config' | 'style' | 'event' | 'advanced'
  label: string
}

const rightTabs: readonly RightTab[] = [
  { id: 'config', label: '页面配置' },
  { id: 'style', label: '样式' },
  { id: 'event', label: '事件' },
  { id: 'advanced', label: '高级' },
]

const activeRightTab = ref<RightTab['id']>('config')

/** 页签键盘导航：方向键在四个页签间循环，Home / End 跳到首尾 */
function onRightTabKeydown(event: KeyboardEvent, index: number): void {
  if (
    event.key !== 'ArrowRight' &&
    event.key !== 'ArrowLeft' &&
    event.key !== 'Home' &&
    event.key !== 'End'
  ) {
    return
  }

  event.preventDefault()

  const last = rightTabs.length - 1
  let next = index
  if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1
  else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1
  else if (event.key === 'Home') next = 0
  else next = last

  activeRightTab.value = rightTabs[next].id
  const tablist = (event.currentTarget as HTMLElement | null)?.closest('[role="tablist"]')
  tablist?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
}

const dockExpanded = ref(true)

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
          <button type="button" class="lc-designer__action" disabled title="预览尚未接入">
            预览
          </button>
          <button type="button" class="lc-designer__action" disabled title="保存尚未接入">
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
        <nav class="lc-rail" aria-label="设计器资源">
          <button
            v-for="item in railItems"
            :key="item.id"
            type="button"
            class="lc-rail__item"
            :class="{ 'lc-rail__item--active': item.id === activeRailId }"
            :disabled="!item.available"
            :aria-label="item.label"
            :aria-current="item.id === activeRailId ? 'true' : undefined"
            :title="item.available ? item.label : `${item.label}（尚未接入）`"
          >
            <span class="lc-rail__glyph" aria-hidden="true">{{ item.glyph }}</span>
            <span aria-hidden="true">{{ item.label }}</span>
          </button>
        </nav>

        <aside class="lc-designer__panel lc-designer__panel--left" aria-label="组件库">
          <div class="lc-app__panel-title">
            <span class="lc-designer__panel-heading">组件库</span>
            <span class="lc-app__panel-meta">拖拽到画布</span>
          </div>
          <LcSlot name="designer.leftPanel" :context="{ documentId }">
            <template #empty>
              <div class="lc-app__empty">暂无面板贡献</div>
            </template>
          </LcSlot>
        </aside>

        <section class="lc-designer__center">
          <div class="lc-designer__stage">
            <CanvasModule :app-context="appCtx" :canvas-context="canvas.context" />
          </div>

          <section
            class="lc-dock"
            :class="{ 'lc-dock--collapsed': !dockExpanded }"
            aria-label="事件流"
          >
            <!--
              外壳只保留折叠按钮：标题与页签由底部面板插件自己提供，
              外壳再画一遍标题会在同一块区域出现两行「事件流」。
            -->
            <header class="lc-dock__header">
              <button
                type="button"
                class="lc-dock__toggle"
                :aria-expanded="dockExpanded"
                aria-controls="lc-dock-panel"
                :aria-label="dockExpanded ? '折叠事件流' : '展开事件流'"
                :title="dockExpanded ? '折叠事件流' : '展开事件流'"
                @click="dockExpanded = !dockExpanded"
              >
                <span
                  class="lc-dock__chevron"
                  :class="{ 'lc-dock__chevron--up': dockExpanded }"
                  aria-hidden="true"
                />
              </button>
            </header>

            <!-- 事件流内容完全由插件通过 designer.bottomPanel 提供，外壳不内置实现 -->
            <div
              v-show="dockExpanded"
              id="lc-dock-panel"
              class="lc-dock__body"
              role="region"
              aria-label="事件流"
            >
              <LcSlot name="designer.bottomPanel" :context="{ documentId }">
                <template #empty>
                  <div class="lc-dock__empty">
                    <span class="lc-dock__empty-title">事件流面板尚未接入</span>
                    <span
                      >安装事件流插件后，面板会通过 designer.bottomPanel 插槽挂载在这里。</span
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
            <p class="lc-designer__placeholder">样式配置尚未接入</p>
          </div>

          <div
            v-show="activeRightTab === 'event'"
            id="lc-tabpanel-event"
            class="lc-designer__tabpanel"
            role="tabpanel"
            aria-labelledby="lc-tab-event"
          >
            <p class="lc-designer__placeholder">事件配置尚未接入</p>
          </div>

          <div
            v-show="activeRightTab === 'advanced'"
            id="lc-tabpanel-advanced"
            class="lc-designer__tabpanel"
            role="tabpanel"
            aria-labelledby="lc-tab-advanced"
          >
            <p class="lc-designer__placeholder">高级配置尚未接入</p>
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
  </ContextScope>
</template>
