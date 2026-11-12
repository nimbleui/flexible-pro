<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import TypeNodeEditor from '../common/TypeNodeEditor.vue'
import { useApiBinding } from './composables/use-api-binding'
import { useDatasourceForm } from './composables/use-datasource-form'
import { usePageDataStore } from './composables/use-page-data-store'
import { useRouteForm } from './composables/use-route-form'
import { useVariableForm } from './composables/use-variable-form'
import { projectPath } from '../../projects/project-path'
import { formatValue } from './utils/data-naming'
import {
  SOURCE_TYPES,
  getSourceSample,
  isEditableSource,
  sourceTypeLabel,
} from './utils/data-source'

const props = defineProps<{
  /** 是否打开弹框 */
  open: boolean
}>()

const emit = defineEmits<{
  (event: 'close'): void
}>()

// schema 读取、订阅与写回规则都在 store 里，三块表单各自只管自己的草稿与校验
const store = usePageDataStore()
const { variables, datasources, route, sourceState } = store

const {
  variableEditing,
  variableError,
  variableDraft,
  deletingVariable,
  variableTypeOptions,
  resetVariableForm,
  openVariableCreate,
  openVariableEdit,
  saveVariable,
  removeVariable,
} = useVariableForm(store)

const {
  sourceEditing,
  sourceError,
  sourceDraft,
  resultDraft,
  deletingSource,
  sourceTypeOptions,
  resetSourceForm,
  openSourceCreate,
  openSourceEdit,
  sourceStatusText,
  sourceStatusTone,
  refreshSource,
  saveSource,
  removeSource,
} = useDatasourceForm(store)

// 引用项目接口只维护 `schema.apis`；展开出的条目由 `bindingPatches` 一并写进 datasources
const {
  apiLabelOf,
  bindingError,
  closePicker,
  confirmBind,
  isBound,
  openPicker,
  pendingBind,
  pickerOpen,
  projectApis,
  projectId,
  startBind,
  unbind,
  unbindingName,
  unresolved,
} = useApiBinding(store)

const { routeParamsText, routeQueryText, routeError, resetRouteDraft, saveRoute } =
  useRouteForm(store)

const activeTab = ref<'variables' | 'datasources' | 'route'>('variables')
const closeButton = ref<HTMLButtonElement | null>(null)

const tabItems = computed(() => [
  { id: 'variables' as const, label: '变量', count: variables.value.length },
  { id: 'datasources' as const, label: '接口数据', count: datasources.value.length },
  {
    id: 'route' as const,
    label: '路由',
    count: (route.value?.params?.length ?? 0) + (route.value?.query?.length ?? 0),
  },
])

function requestClose(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open || event.key !== 'Escape') return
  event.preventDefault()
  requestClose()
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    activeTab.value = 'variables'
    resetVariableForm()
    resetSourceForm()
    resetRouteDraft()
    await nextTick()
    closeButton.value?.focus()
  },
  { immediate: true },
)

onMounted(() => window.addEventListener('keydown', onKeydown))

onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="lc-page-data" @mousedown.self="requestClose">
      <section
        class="lc-page-data__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-page-data-title"
      >
        <header class="lc-page-data__head">
          <div>
            <h2 id="lc-page-data-title" class="lc-page-data__title">页面数据</h2>
            <p class="lc-page-data__subtitle">
              变量与接口数据统一挂在 data
              下；路由只声明参数名，值由运行时提供。函数体保持纯函数，不会自动访问这里的数据。
            </p>
          </div>
          <button
            ref="closeButton"
            type="button"
            class="lc-page-data__close"
            aria-label="关闭页面数据弹框"
            @click="requestClose"
          >
            ×
          </button>
        </header>

        <nav class="lc-page-data__tabs" role="tablist" aria-label="页面数据分类">
          <button
            v-for="tab in tabItems"
            :key="tab.id"
            type="button"
            role="tab"
            class="lc-page-data__tab"
            :aria-selected="activeTab === tab.id"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
            <span>{{ tab.count }}</span>
          </button>
        </nav>

        <div class="lc-page-data__body">
          <!-- 变量 -->
          <section v-if="activeTab === 'variables'" class="lc-page-data__section">
            <template v-if="variableEditing === null">
              <div class="lc-page-data__toolbar">
                <span class="lc-page-data__count">data 下的页面变量</span>
                <button type="button" class="lc-page-data__button" @click="openVariableCreate">
                  + 新建变量
                </button>
              </div>

              <div v-if="variables.length === 0" class="lc-page-data__empty">
                还没有页面变量。变量默认值会进入 data，并决定补全类型。
              </div>

              <ul v-else class="lc-page-data__list">
                <li
                  v-for="(variable, index) in variables"
                  :key="`${variable.name}-${index}`"
                  class="lc-page-data__item"
                >
                  <div class="lc-page-data__item-main">
                    <code class="lc-page-data__name">data.{{ variable.name }}</code>
                    <code class="lc-page-data__value">{{
                      variable.defaultValue === undefined
                        ? '无默认值'
                        : formatValue(variable.defaultValue)
                    }}</code>
                    <p v-if="variable.description" class="lc-page-data__desc">
                      {{ variable.description }}
                    </p>
                  </div>
                  <div class="lc-page-data__actions">
                    <template v-if="deletingVariable === index">
                      <span class="lc-page-data__confirm">删除？</span>
                      <button
                        type="button"
                        class="lc-page-data__button lc-page-data__button--danger"
                        @click="removeVariable(index)"
                      >
                        确认
                      </button>
                      <button
                        type="button"
                        class="lc-page-data__button"
                        @click="deletingVariable = null"
                      >
                        取消
                      </button>
                    </template>
                    <template v-else>
                      <button
                        type="button"
                        class="lc-page-data__button"
                        @click="openVariableEdit(index)"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        class="lc-page-data__button lc-page-data__button--danger"
                        @click="deletingVariable = index"
                      >
                        删除
                      </button>
                    </template>
                  </div>
                </li>
              </ul>
            </template>

            <form v-else class="lc-page-data__form" @submit.prevent="saveVariable">
              <div class="lc-page-data__field">
                <span>变量定义</span>
                <div class="lc-page-data__type-editor">
                  <TypeNodeEditor
                    :node="variableDraft"
                    :type-options="variableTypeOptions"
                    show-name
                    show-value
                  />
                </div>
                <small>
                  填写名称、类型、说明与默认值；对象/数组继续添加字段，默认值会进入 data。
                </small>
              </div>
              <p v-if="variableError" class="lc-page-data__error" role="alert">
                {{ variableError }}
              </p>
              <div class="lc-page-data__actions lc-page-data__actions--end">
                <button type="button" class="lc-page-data__button" @click="resetVariableForm">
                  取消
                </button>
                <button
                  type="submit"
                  class="lc-page-data__button lc-page-data__button--primary"
                >
                  {{ variableEditing === 'new' ? '创建变量' : '保存变量' }}
                </button>
              </div>
            </form>
          </section>

          <!-- 数据源 -->
          <section v-else-if="activeTab === 'datasources'" class="lc-page-data__section">
            <template v-if="sourceEditing === null">
              <div class="lc-page-data__toolbar">
                <span class="lc-page-data__count">
                  结果在 data.&lt;数据源名&gt;.data，状态在 .loading / .loaded / .error
                </span>
                <div class="lc-page-data__toolbar-actions">
                  <button
                    type="button"
                    class="lc-page-data__button"
                    :aria-expanded="pickerOpen"
                    @click="pickerOpen ? closePicker() : openPicker()"
                  >
                    引用项目接口
                  </button>
                  <button type="button" class="lc-page-data__button" @click="openSourceCreate">
                    + 新建接口数据
                  </button>
                </div>
              </div>

              <div v-if="pickerOpen" class="lc-page-data__picker">
                <div class="lc-page-data__picker-head">
                  <span class="lc-page-data__picker-title">引用项目接口</span>
                  <button
                    type="button"
                    class="lc-page-data__close"
                    aria-label="关闭引用面板"
                    title="关闭"
                    @click="closePicker"
                  >
                    ×
                  </button>
                </div>
                <div v-if="projectApis.length === 0" class="lc-page-data__picker-empty">
                  <p>
                    这个项目还没登记接口。登记之后就能在这里引用，接口地址改动会同步到所有引用它的页面。
                  </p>
                  <RouterLink class="lc-page-data__button" :to="projectPath(projectId, 'apis')">
                    去接口管理登记
                  </RouterLink>
                </div>

                <template v-else-if="pendingBind === null">
                  <button
                    v-for="row in projectApis"
                    :key="row.api.id"
                    type="button"
                    class="lc-page-data__picker-item"
                    @click="startBind(row.api)"
                  >
                    <span class="lc-page-data__picker-name">{{ row.api.name }}</span>
                    <code class="lc-page-data__picker-path"
                      >{{ row.api.method }} {{ row.api.path }}</code
                    >
                    <span v-if="row.boundCount > 0" class="lc-page-data__badge">
                      本页已引用 {{ row.boundCount }} 次
                    </span>
                  </button>
                </template>

                <form v-else class="lc-page-data__form" @submit.prevent="confirmBind">
                  <p class="lc-page-data__picker-target">
                    引用「{{ pendingBind.api.name }}」
                    <code>{{ pendingBind.api.method }} {{ pendingBind.api.path }}</code>
                  </p>
                  <label class="lc-page-data__field">
                    <span>绑定名（data.&lt;绑定名&gt;）</span>
                    <input v-model="pendingBind.name" type="text" autocomplete="off" />
                  </label>
                  <label class="lc-page-data__check">
                    <input v-model="pendingBind.autoFetch" type="checkbox" />
                    进入页面就自动取数
                  </label>
                  <p v-if="bindingError" class="lc-page-data__error">{{ bindingError }}</p>
                  <div class="lc-page-data__actions">
                    <button type="button" class="lc-page-data__button" @click="closePicker">
                      取消
                    </button>
                    <button
                      type="submit"
                      class="lc-page-data__button lc-page-data__button--primary"
                    >
                      建立引用
                    </button>
                  </div>
                </form>
              </div>

              <div v-if="datasources.length === 0" class="lc-page-data__empty">
                还没有接口数据。引用项目接口可以复用已登记的地址，新建则只属于本页。
              </div>

              <ul v-else class="lc-page-data__list">
                <li
                  v-for="(source, index) in datasources"
                  :key="`${source.id}-${index}`"
                  class="lc-page-data__item"
                >
                  <div class="lc-page-data__item-main">
                    <div class="lc-page-data__item-head">
                      <code class="lc-page-data__name">data.{{ source.id }}</code>
                      <span class="lc-page-data__badge">{{
                        sourceTypeLabel(source.type)
                      }}</span>
                      <span v-if="apiLabelOf(source.id)" class="lc-page-data__badge">
                        项目接口 · {{ apiLabelOf(source.id) }}
                      </span>
                      <span
                        class="lc-page-data__status"
                        :data-tone="sourceStatusTone(source.id)"
                        :title="sourceStatusText(source.id)"
                      >
                        {{ sourceStatusText(source.id) }}
                      </span>
                    </div>
                    <code class="lc-page-data__value">{{
                      getSourceSample(source) === undefined
                        ? '未声明示例结构'
                        : formatValue(getSourceSample(source))
                    }}</code>
                    <p v-if="source.description" class="lc-page-data__desc">
                      {{ source.description }}
                    </p>
                  </div>
                  <div class="lc-page-data__actions">
                    <button
                      v-if="source.type === 'rest' && deletingSource !== index"
                      type="button"
                      class="lc-page-data__button"
                      :disabled="sourceState(source.id)?.loading === true"
                      :title="sourceState(source.id)?.loading ? '请求进行中' : '重新请求'"
                      @click="refreshSource(source.id)"
                    >
                      刷新
                    </button>

                    <template v-if="deletingSource === index">
                      <span class="lc-page-data__confirm">删除？</span>
                      <button
                        type="button"
                        class="lc-page-data__button lc-page-data__button--danger"
                        @click="removeSource(index)"
                      >
                        确认
                      </button>
                      <button
                        type="button"
                        class="lc-page-data__button"
                        @click="deletingSource = null"
                      >
                        取消
                      </button>
                    </template>

                    <!-- 绑定的条目内容归项目维护，这里只能解绑：给它「编辑」会做出一个改不动的地址 -->
                    <template v-else-if="isBound(source.id)">
                      <template v-if="unbindingName === source.id">
                        <span class="lc-page-data__confirm">解除引用？</span>
                        <button
                          type="button"
                          class="lc-page-data__button lc-page-data__button--danger"
                          @click="unbind(source.id)"
                        >
                          确认
                        </button>
                        <button
                          type="button"
                          class="lc-page-data__button"
                          @click="unbindingName = null"
                        >
                          取消
                        </button>
                      </template>
                      <button
                        v-else
                        type="button"
                        class="lc-page-data__button"
                        @click="unbindingName = source.id"
                      >
                        解除引用
                      </button>
                    </template>

                    <template v-else>
                      <button
                        type="button"
                        class="lc-page-data__button"
                        :disabled="!isEditableSource(source)"
                        :title="
                          isEditableSource(source) ? '编辑' : '该类型暂不支持在弹框中编辑'
                        "
                        @click="openSourceEdit(index)"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        class="lc-page-data__button lc-page-data__button--danger"
                        @click="deletingSource = index"
                      >
                        删除
                      </button>
                    </template>
                  </div>
                </li>
              </ul>
              <!-- 悬空引用单独列出来：它展开不出内容，所以在上面的列表里根本不会出现 -->
              <ul v-if="unresolved.length > 0" class="lc-page-data__list">
                <li
                  v-for="binding in unresolved"
                  :key="`dangling-${binding.id}`"
                  class="lc-page-data__item"
                >
                  <div class="lc-page-data__item-main">
                    <div class="lc-page-data__item-head">
                      <code class="lc-page-data__name">data.{{ binding.id }}</code>
                      <span class="lc-page-data__badge">引用失效</span>
                    </div>
                    <p class="lc-page-data__desc">
                      它指向的接口（{{ binding.apiId }}）已不在这个项目里，取不到数据。
                    </p>
                  </div>
                  <div class="lc-page-data__actions">
                    <button
                      type="button"
                      class="lc-page-data__button lc-page-data__button--danger"
                      @click="unbind(binding.id)"
                    >
                      解除引用
                    </button>
                  </div>
                </li>
              </ul>
            </template>

            <form v-else class="lc-page-data__form" @submit.prevent="saveSource">
              <div class="lc-page-data__grid">
                <label class="lc-page-data__field">
                  <span>数据源名</span>
                  <input
                    v-model="sourceDraft.id"
                    type="text"
                    autocomplete="off"
                    placeholder="如 users"
                  />
                </label>
                <label class="lc-page-data__field">
                  <span>类型</span>
                  <select v-model="sourceDraft.type">
                    <option
                      v-for="option in SOURCE_TYPES"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </select>
                </label>
              </div>

              <label v-if="sourceDraft.type === 'rest'" class="lc-page-data__field">
                <span>请求地址</span>
                <input v-model="sourceDraft.url" type="text" placeholder="如 /api/users" />
              </label>

              <div class="lc-page-data__field">
                <span>结果结构</span>
                <div class="lc-page-data__type-editor">
                  <TypeNodeEditor
                    :node="resultDraft"
                    :type-options="sourceTypeOptions"
                    show-value
                  />
                </div>
                <small>
                  对象/数组继续添加字段或元素；示例值用于补全与 mock/静态数据，不会被当作 REST
                  的真实数据。运行时通过 data.&lt;数据源名&gt;.data 访问结果。
                </small>
              </div>

              <label class="lc-page-data__field">
                <span>说明</span>
                <input v-model="sourceDraft.description" type="text" placeholder="可选" />
              </label>

              <label v-if="sourceDraft.type === 'rest'" class="lc-page-data__check">
                <input v-model="sourceDraft.autoFetch" type="checkbox" />
                <span>页面打开时自动请求</span>
              </label>

              <p v-if="sourceError" class="lc-page-data__error" role="alert">
                {{ sourceError }}
              </p>
              <div class="lc-page-data__actions lc-page-data__actions--end">
                <button type="button" class="lc-page-data__button" @click="resetSourceForm">
                  取消
                </button>
                <button
                  type="submit"
                  class="lc-page-data__button lc-page-data__button--primary"
                >
                  {{ sourceEditing === 'new' ? '创建数据源' : '保存数据源' }}
                </button>
              </div>
            </form>
          </section>

          <!-- 路由 -->
          <section v-else class="lc-page-data__section">
            <p class="lc-page-data__hint">
              每行一个参数，可写成
              <code>id: 用户 ID</code>。这里只声明补全契约，真实值由宿主路由注入。
            </p>
            <label class="lc-page-data__field">
              <span>路径参数（$params）</span>
              <textarea
                v-model="routeParamsText"
                rows="4"
                spellcheck="false"
                placeholder="id: 用户 ID"
              />
            </label>
            <label class="lc-page-data__field">
              <span>查询参数（$query）</span>
              <textarea
                v-model="routeQueryText"
                rows="4"
                spellcheck="false"
                placeholder="tab: 当前页签"
              />
            </label>
            <p v-if="routeError" class="lc-page-data__error" role="alert">{{ routeError }}</p>
            <div class="lc-page-data__actions lc-page-data__actions--end">
              <button type="button" class="lc-page-data__button" @click="resetRouteDraft">
                重置
              </button>
              <button
                type="button"
                class="lc-page-data__button lc-page-data__button--primary"
                @click="saveRoute"
              >
                保存路由声明
              </button>
            </div>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<!--
  样式按类族拆到 styles/*.css，块顺序与拆分前的单一 style 完全一致：
  新增样式请追加到末尾，不要插进中间。
-->
<style scoped src="./styles/shell.css"></style>
<style scoped src="./styles/dialog.css"></style>
<style scoped src="./styles/tabs.css"></style>
<style scoped src="./styles/common.css"></style>
<style scoped src="./styles/list.css"></style>
<style scoped src="./styles/form.css"></style>
<style scoped src="./styles/states.css"></style>
