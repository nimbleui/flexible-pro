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
  MaterialService,
} from '@lc/contracts'
import { ContextScope, LcSlot, useAppContext, useRegistryList } from '@lc/vue'
import type { ComponentSchema } from '@lc/schema'
import { CanvasModule } from '../canvasRemote'
import ComponentDefinitionForm from '../components/custom-components/ComponentDefinitionForm.vue'
import StatusBar from '../components/StatusBar.vue'
import OverlayPanel from '../components/OverlayPanel.vue'
import ToolbarStock from '../components/ToolbarStock.vue'
import type { CustomComponentDraft } from '../custom-components/component-draft'
import {
  EMPTY_COMPONENT_DRAFT,
  definitionsFromDraft,
  draftFromDefinition,
  eventsFromDraft,
  metaFromDraft,
  slotsFromDraft,
} from '../custom-components/component-draft'
import {
  blueprintDocumentId,
  blueprintSchemaOf,
  definitionFromBlueprint,
} from '../custom-components/blueprint-document'
import {
  CUSTOM_PLUGIN,
  customComponents,
  saveCustomComponent,
} from '../custom-components/custom-components'

/**
 * 组件蓝图编辑器。
 *
 * 只编辑已落库的记录：新建走列表页的弹框，定义（名称、属性、事件）先确定再进画布。
 *
 * 与页面设计器共用同一块远程画布：外壳只多了一件事——把定义表的默认值注入画布作用域的
 * `props`，于是蓝图里的 `{{ props.xxx }}` 在设计态就显示真实取值。
 * 蓝图是一次性的编辑会话，因此 Realm 随视图创建、随视图释放；不释放的话，
 * 下次进来会接着上次未保存的中间态编辑，而不是组件的最新定义。
 */

/** 一条编辑会话 = 一个文档 Realm + 一个画布 Realm；记录不存在时整体为 null */
interface BlueprintSession {
  /** 文档 Realm：历史与定义表都挂在它上面 */
  editor: EditorRealm
  /** 画布 Realm：随视图创建，卸载时释放 */
  canvas: CanvasRealm
}

const BLUEPRINT_TABS = [
  { id: 'node', label: '节点属性' },
  { id: 'style', label: '样式' },
  { id: 'definition', label: '组件定义' },
] as const

type BlueprintTab = (typeof BLUEPRINT_TABS)[number]['id']

const appCtx = useAppContext()
const route = useRoute()
const router = useRouter()

const componentId = typeof route.params.componentId === 'string' ? route.params.componentId : ''
const stored = customComponents.value.find((item) => item.id === componentId)
/** 带上了 id 却找不到条目：多半是删掉后从历史链接回来 */
const isMissing = stored === undefined

const initialDraft = computed<CustomComponentDraft>(() =>
  stored ? draftFromDefinition(stored.definition, stored.id) : { ...EMPTY_COMPONENT_DRAFT },
)

const documentId = blueprintDocumentId(componentId)
const session: BlueprintSession | null = isMissing
  ? null
  : createSession(
      appCtx.workspace.getEditor(documentId),
      stored.definition,
      stored.definition.meta.title,
    )

/**
 * 创建编辑会话。
 *
 * 复用已存在的 Realm 只为覆盖热更新重挂视图的情形：同一 documentId 二次
 * `createEditorRealm` 会被 workspace 直接抛错。
 */
function createSession(
  opened: EditorRealm | undefined,
  definition: ComponentSchema,
  title: string,
): BlueprintSession | null {
  if (opened) return { editor: opened, canvas: opened.createCanvasRealm() }

  try {
    const editor = appCtx.workspace.createEditorRealm({
      documentId,
      title: `${title} · 蓝图`,
      schema: blueprintSchemaOf(definition, documentId),
    })
    return { editor, canvas: editor.createCanvasRealm() }
  } catch (error) {
    console.error('[host] 创建组件蓝图会话失败', error)
    return null
  }
}

const materials = useRegistryList(() => appCtx.get<MaterialService>('material'))

/** 已被占用的物料名；正在编辑的这条不算，否则改名绕一圈再改回来会被自己的历史值挡住 */
const takenNames = computed<readonly string[]>(() => {
  const contributions = materials.value
    .filter((entry) => entry.plugin !== CUSTOM_PLUGIN)
    .map((entry) => entry.name)
  const siblings = customComponents.value
    .filter((item) => item.id !== componentId)
    .map((item) => item.definition.meta.name)
  return [...new Set([...contributions, ...siblings])]
})

/**
 * 注入画布的属性默认值作用域。
 *
 * 初值来自定义表，之后每次改动都整体替换引用：`CanvasStage` 的渲染树按
 * `props.scope` 求值，换引用才能触发重建。
 */
const defaultProps = ref<Record<string, unknown>>(defaultsOf(initialDraft.value))

const canvasScope = computed<Record<string, unknown>>(() => ({
  props: { ...defaultProps.value },
}))

function defaultsOf(draft: CustomComponentDraft): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const definition of definitionsFromDraft(draft.props)) {
    if (definition.defaultValue !== undefined) values[definition.name] = definition.defaultValue
  }
  return values
}

/** 服务就绪门：`plugin()` 只做登记，画布核心要等运行时空闲才可用 */
const ready = shallowRef(false)
const canvasService = shallowRef<CanvasService | null>(null)
const commandService = shallowRef<CommandService | null>(null)
const documentService = shallowRef<DocumentService | null>(null)

const version = ref(0)
const docVersion = shallowRef(0)
const savedVersion = shallowRef(0)
const metaDirty = shallowRef(false)
const notice = ref('')
const activeTab = ref<BlueprintTab>('node')
const overlayOpen = ref(false)
const form = ref<InstanceType<typeof ComponentDefinitionForm> | null>(null)

const disposables: Array<{
  /** 释放该条订阅；卸载时逐个调用，重复调用由注册方保证幂等 */
  dispose(): void
}> = []
let unmounted = false

/** 定义表或画布还有未保存的改动 */
const isDirty = computed(() => docVersion.value !== savedVersion.value || metaDirty.value)

const zoomLabel = computed(() => {
  version.value
  const service = canvasService.value
  return service ? `${Math.round(service.viewport.state.zoom * 100)}%` : '—'
})

const canUndo = computed(() => commandEnabled('canvas.undo'))
const canRedo = computed(() => commandEnabled('canvas.redo'))

function commandEnabled(id: string): boolean {
  version.value
  const command = commandService.value?.get(id)
  return command ? (command.enabled?.() ?? true) : false
}

function runCommand(id: string): void {
  void commandService.value?.execute(id)
}

onMounted(async () => {
  if (!session) return
  await appCtx.runtime.whenIdle()
  // 等待期间用户可能已经离开：此时 Realm 已释放，不能再访问服务
  if (unmounted) return

  const { editor, canvas } = session
  if (window.__lc) window.__lc.canvas = canvas

  canvasService.value = canvas.context.require<CanvasService>('canvas')
  commandService.value = canvas.context.get<CommandService>('command') ?? null
  documentService.value = editor.context.get<DocumentService>('document') ?? null

  savedVersion.value = documentService.value?.model.version ?? 0
  // 热更新复用了已有 Realm 时，起始版本可能不是 0：两边对齐才不会一进来就显示未保存
  docVersion.value = savedVersion.value

  const command = commandService.value
  if (command)
    disposables.push(
      command.onDidChange(() => {
        version.value += 1
      }),
    )
  disposables.push(
    canvasService.value.viewport.onDidChange(() => {
      version.value += 1
    }),
  )

  const document = documentService.value
  if (document) {
    disposables.push(
      document.onDidChange((model) => {
        docVersion.value = model.version
      }),
    )
  }

  // 撤销 / 重做的可用态由历史栈决定，而历史服务不是响应式源：
  // 不订阅就会出现在「能撤销但按钮一直灰着」
  const history = editor.context.get<HistoryService>('history')
  if (history)
    disposables.push(
      history.onDidChange(() => {
        version.value += 1
      }),
    )

  registerEntryGuards()
  ready.value = true
})

onUnmounted(() => {
  unmounted = true
  for (const disposable of disposables.splice(0)) disposable.dispose()
  if (session) {
    session.canvas.dispose()
    session.editor.dispose()
  }
  if (session && window.__lc?.canvas === session.canvas) window.__lc.canvas = undefined
})

/**
 * 把「自定义函数」「页面数据」两个入口物料挡在蓝图之外。
 *
 * 它们写的是页面文档的 `functions` / `variables` / `datasources`，都不属于组件定义；
 * 不注册的话点击会静默失败，注册成提示才能解释「为什么点了没反应」。
 */
function registerEntryGuards(): void {
  const command = commandService.value
  if (!command) return

  const guard = (id: string, label: string): void => {
    const registration = command.register({
      id,
      title: label,
      run: () => {
        notice.value = `组件蓝图暂不支持「${label}」：它写入的是页面文档，不属于组件定义。`
      },
    })
    // register 返回 Disposable，与订阅一起回收
    disposables.push(registration)
  }

  guard('pageFunction.openDialog', '自定义函数')
  guard('pageData.openDialog', '页面数据')
}

function onDefinitionChange(draft: CustomComponentDraft): void {
  metaDirty.value = true
  defaultProps.value = defaultsOf(draft)
}

function onTabKeydown(event: KeyboardEvent, index: number): void {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return

  event.preventDefault()
  const last = BLUEPRINT_TABS.length - 1
  const next =
    event.key === 'ArrowRight'
      ? index === last
        ? 0
        : index + 1
      : index === 0
        ? last
        : index - 1
  const target = BLUEPRINT_TABS[next]
  if (!target) return

  activeTab.value = target.id
  const tablist = (event.currentTarget as HTMLElement | null)?.closest('[role="tablist"]')
  tablist?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
}

function goBack(): void {
  void router.push('/components')
}

/**
 * 保存组件。
 *
 * 节点图以文档快照为准（含画布写入的样式、显隐、锁定与旋转），元信息与对外属性
 * 以定义表为准；两块各有唯一写入方。`saveCustomComponent` 会拒绝缺少根节点的定义。
 */
function save(): void {
  const document = documentService.value
  if (!document) return

  const issues = form.value?.validate() ?? []
  if (issues.length > 0) {
    activeTab.value = 'definition'
    notice.value = `定义表还有 ${issues.length} 处需要修正，未保存。`
    return
  }

  const draft = form.value?.snapshot() ?? initialDraft.value
  try {
    saveCustomComponent({
      id: componentId,
      definition: definitionFromBlueprint(document.model.schema, {
        meta: metaFromDraft(draft),
        props: definitionsFromDraft(draft.props),
        events: eventsFromDraft(draft.events),
        slots: slotsFromDraft(draft.slots),
      }),
      // 启停只在列表页改，这里沿用记录里的状态，避免两个页面抢同一个开关
      enabled: stored?.enabled ?? true,
    })
    savedVersion.value = document.model.version
    docVersion.value = savedVersion.value
    metaDirty.value = false
    notice.value = ''
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <div v-if="isMissing || !session" class="lc-blueprint__missing">
    <span class="lc-blueprint__missing-title">组件不存在</span>
    <span>它可能已被删除，或链接中的 id 不正确。</span>
    <button type="button" class="lc-blueprint__button" @click="goBack">返回组件列表</button>
  </div>

  <div v-else-if="!ready" class="lc-designer__loading">蓝图装载中…</div>

  <ContextScope v-else :context="session.editor.context">
    <div class="lc-designer">
      <div class="lc-designer__toolbar" role="toolbar" aria-label="蓝图工具条">
        <nav class="lc-designer__crumbs" aria-label="当前位置">
          <RouterLink class="lc-designer__crumb" to="/components">组件管理</RouterLink>
          <span class="lc-designer__crumb-sep" aria-hidden="true">/</span>
          <span class="lc-designer__crumb lc-designer__crumb--current">
            {{ initialDraft.title }}
          </span>
        </nav>

        <span class="lc-designer__divider" aria-hidden="true" />

        <div class="lc-designer__group">
          <button
            type="button"
            class="lc-icon-button"
            aria-label="撤销"
            title="撤销（Ctrl/Cmd+Z）"
            :disabled="!canUndo"
            @click="runCommand('canvas.undo')"
          >
            <span aria-hidden="true">↺</span>
          </button>
          <button
            type="button"
            class="lc-icon-button"
            aria-label="重做"
            title="重做（Ctrl/Cmd+Shift+Z）"
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

        <!-- 对齐 / 成组等画布命令仍由插件贡献，外壳只提供滚动带 -->
        <div class="lc-designer__plugins">
          <ToolbarStock />
        </div>

        <p v-if="notice" class="lc-blueprint__notice" role="alert">
          {{ notice }}
          <button
            type="button"
            class="lc-blueprint__notice-close"
            aria-label="关闭提示"
            @click="notice = ''"
          >
            ×
          </button>
        </p>

        <div class="lc-designer__actions">
          <span class="lc-blueprint__state" :class="{ 'lc-blueprint__state--dirty': isDirty }">
            {{ isDirty ? '未保存' : '已保存' }}
          </span>
          <button
            type="button"
            class="lc-designer__action"
            :aria-pressed="overlayOpen"
            title="在画布右侧浮出页面大纲"
            @click="overlayOpen = !overlayOpen"
          >
            页面大纲
          </button>
          <button type="button" class="lc-designer__action" @click="goBack">返回列表</button>
          <button
            type="button"
            class="lc-designer__action lc-designer__action--primary"
            @click="save"
          >
            保存组件
          </button>
        </div>
      </div>

      <div class="lc-designer__body">
        <aside class="lc-designer__panel lc-designer__panel--left" aria-label="组件库">
          <!-- 标题与搜索由面板自己提供，外壳再画一遍会叠成两行 -->
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
              :canvas-context="session.canvas.context"
              :scope="canvasScope"
            />
            <!-- 大纲从左侧插槽搬到浮动面板后，蓝图编辑器用工具条按钮开关它 -->
            <OverlayPanel
              v-show="overlayOpen"
              title="页面大纲"
              slot-name="designer.overlayPanel"
              :context="{ documentId }"
              @close="overlayOpen = false"
            />
          </div>
        </section>

        <aside class="lc-designer__panel lc-designer__panel--right" aria-label="蓝图设置">
          <div class="lc-designer__tabs" role="tablist" aria-label="蓝图设置页签">
            <button
              v-for="(tab, index) in BLUEPRINT_TABS"
              :id="`lc-blueprint-tab-${tab.id}`"
              :key="tab.id"
              type="button"
              role="tab"
              class="lc-designer__tab"
              :aria-selected="activeTab === tab.id"
              :aria-controls="`lc-blueprint-tabpanel-${tab.id}`"
              :tabindex="activeTab === tab.id ? 0 : -1"
              @click="activeTab = tab.id"
              @keydown="onTabKeydown($event, index)"
            >
              {{ tab.label }}
            </button>
          </div>

          <div
            v-show="activeTab === 'node'"
            id="lc-blueprint-tabpanel-node"
            class="lc-designer__tabpanel"
            role="tabpanel"
            aria-labelledby="lc-blueprint-tab-node"
          >
            <LcSlot name="designer.rightPanel" :context="{ documentId }">
              <template #empty>
                <div class="lc-app__empty">暂无属性面板</div>
              </template>
            </LcSlot>
          </div>

          <!-- 锁位约束（决定实例改尺寸时谁拉伸、谁贴边、谁不动）在样式面板里编辑 -->
          <div
            v-show="activeTab === 'style'"
            id="lc-blueprint-tabpanel-style"
            class="lc-designer__tabpanel"
            role="tabpanel"
            aria-labelledby="lc-blueprint-tab-style"
          >
            <LcSlot name="designer.stylePanel" :context="{ documentId }">
              <template #empty>
                <div class="lc-app__empty">暂无样式面板</div>
              </template>
            </LcSlot>
          </div>

          <div
            v-show="activeTab === 'definition'"
            id="lc-blueprint-tabpanel-definition"
            class="lc-designer__tabpanel"
            role="tabpanel"
            aria-labelledby="lc-blueprint-tab-definition"
          >
            <ComponentDefinitionForm
              :key="documentId"
              ref="form"
              :initial="initialDraft"
              :taken-names="takenNames"
              @change="onDefinitionChange"
            />
          </div>
        </aside>
      </div>

      <StatusBar :canvas-context="session.canvas.context" />
    </div>
  </ContextScope>
</template>

<style scoped>
.lc-blueprint__missing {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 32px 36px;
  color: var(--lc-text-secondary);
  font-size: 13px;
}

.lc-blueprint__missing-title {
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-blueprint__button {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--lc-border);
  border-radius: 8px;
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-blueprint__button:hover {
  border-color: var(--lc-accent);
  color: var(--lc-accent-bright);
}

.lc-blueprint__state {
  align-self: center;
  color: var(--lc-text-muted);
  font-size: 11px;
}

.lc-blueprint__state--dirty {
  color: var(--lc-warning);
}

.lc-blueprint__notice {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 420px;
  margin: 0;
  padding: 4px 8px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
  font-size: 11px;
  line-height: 1.5;
}

.lc-blueprint__notice-close {
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

@media (prefers-reduced-motion: reduce) {
  .lc-blueprint__button {
    transition: none;
  }
}
</style>
