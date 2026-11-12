<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ApiMethod, ProjectApi } from '@lc/schema'
import { formatJsonValue } from '@lc/shared'
import ApiGlobalConfig from '../components/api/ApiGlobalConfig.vue'
import ApiDetail from '../components/api/ApiDetail.vue'
import type { ApiDraft } from '../components/api/api-draft'
import { createApiDraft, draftFromApi } from '../components/api/api-draft'
import type { TypeNodeDraft } from '../components/common/type-node'
import {
  createTypeNode,
  typeNodeFromSample,
  typeNodeFromValueType,
} from '../components/common/type-node'
import { apisOfProject, moveApi } from '../apis/api-store'
import { projectPath } from '../projects/project-path'
import { toastService } from '../toast'

/**
 * 接口管理主控台：页头 + 全局配置卡片 + 左侧清单 / 右侧编辑区。
 *
 * 三条路由（列表 / 新建 / 编辑）共用这一页，URL 只决定选中项；草稿与结果类型按条目 id
 * 缓存在本页，切换选中不丢未保存修改——与函数主控台同一约定。接口是项目级资产，
 * 登记一次、页面按名字引用，所以列表按登记顺序平铺，拖拽是唯一的排序入口。
 */

const route = useRoute()
const router = useRouter()
const projectId = String(route.params.projectId)

/** 每页条数：清单高度有限，分页让长项目不必一屏滚到底 */
const PAGE_SIZE = 8

const search = ref('')
const page = ref(1)
const helpOpen = ref(false)
const dragId = ref<string | null>(null)

const isNewRoute = computed(() => route.name === 'project-api-new')

const projectApis = computed<readonly ProjectApi[]>(() => apisOfProject(projectId))

const filtered = computed<readonly ProjectApi[]>(() => {
  const keyword = search.value.trim().toLowerCase()
  if (keyword === '') return projectApis.value

  return projectApis.value.filter((api) => {
    const haystack = [
      api.name,
      api.path,
      api.description ?? '',
      api.group ?? '',
      ...(api.tags ?? []),
    ]
      .join('\n')
      .toLowerCase()

    return haystack.includes(keyword)
  })
})

/**
 * 选中项由 URL 决定：编辑路由按 id 找（已按项目过滤），列表路由自动选第一条，
 * 新建路由恒为 null。刷新 / 分享链接都能回到同一个编辑现场。
 */
const selected = computed<ProjectApi | null>(() => {
  if (isNewRoute.value) return null
  const id = route.params.apiId
  if (typeof id === 'string') {
    return projectApis.value.find((item) => item.id === id) ?? null
  }
  return projectApis.value[0] ?? null
})

const isMissing = computed(
  () => !isNewRoute.value && typeof route.params.apiId === 'string' && selected.value === null,
)

const activeKey = computed(() => {
  if (isNewRoute.value) return 'new'
  return selected.value?.id ?? ''
})

/** 草稿缓存：键是条目 id（新建用 'new'）；reactive Map 让 computed 感知 watch 里的写入 */
const drafts = reactive(new Map<string, ApiDraft>())
const resultDrafts = reactive(new Map<string, TypeNodeDraft>())

function resultNodeOf(api: ProjectApi | null): TypeNodeDraft {
  return api
    ? typeNodeFromValueType('', api.resultType ?? { kind: 'unknown' }, api.sample)
    : createTypeNode('', 'unknown')
}

watch(
  activeKey,
  (key) => {
    if (key === '' || drafts.has(key)) return
    drafts.set(key, key === 'new' ? createApiDraft() : draftFromApi(selected.value!))
    resultDrafts.set(key, resultNodeOf(key === 'new' ? null : selected.value))
  },
  { immediate: true },
)

const activeDraft = computed(() => drafts.get(activeKey.value) ?? null)
const activeResultDraft = computed(() => resultDrafts.get(activeKey.value) ?? null)

const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
const pageRows = computed(() =>
  filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
)

/** 页码窗口：总页数少时全列，多时首尾 + 当前邻域，空档用 0 表示省略号 */
const pageList = computed(() => {
  const total = pageCount.value
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)

  const wanted = [1, total, page.value - 1, page.value, page.value + 1]
  const sorted = [...new Set(wanted)].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b)

  const result: number[] = []
  let prev = 0
  for (const p of sorted) {
    if (p - prev > 1) result.push(0)
    result.push(p)
    prev = p
  }

  return result
})

watch(search, () => {
  page.value = 1
})

watch(pageCount, (total) => {
  if (page.value > total) page.value = total
})

// 选中项不在当前页时翻到它所在页：URL 直达 / 新建保存后跳转都能落在正确的页上
watch(
  selected,
  (api) => {
    if (!api || search.value.trim() !== '') return
    const index = filtered.value.findIndex((item) => item.id === api.id)
    if (index < 0) return
    const target = Math.floor(index / PAGE_SIZE) + 1
    if (target !== page.value) page.value = target
  },
  { immediate: true },
)

const METHOD_SHORT: Readonly<Record<ApiMethod, string>> = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DEL',
  PATCH: 'PATCH',
}

function select(id: string): void {
  if (route.params.apiId === id) return
  void router.replace(projectPath(projectId, `apis/${id}/edit`))
}

function goNew(): void {
  void router.replace(projectPath(projectId, 'apis/new'))
}

function goList(): void {
  void router.replace(projectPath(projectId, 'apis'))
}

function onDragStart(api: ProjectApi, event: DragEvent): void {
  if (search.value.trim() !== '') {
    event.preventDefault()
    return
  }
  dragId.value = api.id
  event.dataTransfer?.setData('text/plain', api.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(event: DragEvent): void {
  if (dragId.value !== null) event.preventDefault()
}

function onDrop(target: ProjectApi, event: DragEvent): void {
  event.preventDefault()
  if (dragId.value !== null && dragId.value !== target.id) {
    moveApi(dragId.value, target.id)
  }
  dragId.value = null
}

function onDragEnd(): void {
  dragId.value = null
}

/** 新建保存成功后把 URL 换成真实 id；导航完成后再清 'new' 草稿，避免编辑区闪断 */
function onSaved(api: ProjectApi): void {
  if (!isNewRoute.value) return
  drafts.set(api.id, draftFromApi(api))
  resultDrafts.set(api.id, resultNodeOf(api))
  void router.replace(projectPath(projectId, `apis/${api.id}/edit`)).then(() => {
    drafts.delete('new')
    resultDrafts.delete('new')
  })
}

function onRemoved(id: string): void {
  drafts.delete(id)
  resultDrafts.delete(id)
  if (route.params.apiId === id) goList()
}

function onReset(): void {
  const key = activeKey.value
  if (key === '') return
  drafts.set(key, key === 'new' ? createApiDraft() : draftFromApi(selected.value!))
  resultDrafts.set(key, resultNodeOf(key === 'new' ? null : selected.value))
}

function onCapture(body: unknown): void {
  const key = activeKey.value
  const draft = drafts.get(key)
  if (!draft) return
  draft.sampleText = formatJsonValue(body)
  resultDrafts.set(key, typeNodeFromSample('', body))
  toastService.show('已用这次响应填充样本与结果类型', 'success')
}

function onKeydown(event: KeyboardEvent): void {
  if (helpOpen.value && event.key === 'Escape') {
    event.preventDefault()
    helpOpen.value = false
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))

onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <main class="lc-apis">
    <header class="lc-apis__head">
      <div class="lc-apis__heading">
        <h1 class="lc-apis__title">接口管理</h1>
        <p class="lc-apis__subtitle">
          统一管理接口配置与全局参数，支持多环境配置，快速调用后端服务
        </p>
      </div>
      <div class="lc-apis__actions">
        <button type="button" class="lc-apis__docs" @click="helpOpen = true">
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
          使用文档
        </button>
        <button type="button" class="lc-apis__primary" @click="goNew">+ 新建接口</button>
      </div>
    </header>

    <ApiGlobalConfig :project-id="projectId" />

    <div class="lc-apis__body">
      <aside class="lc-apis__list" aria-label="接口列表">
        <div class="lc-apis__list-head">
          <label class="lc-apis__search">
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              v-model="search"
              type="search"
              class="lc-apis__search-input"
              placeholder="搜索接口名称或地址..."
              aria-label="搜索接口名称或地址"
            />
          </label>
          <button type="button" class="lc-apis__primary lc-apis__primary--sm" @click="goNew">
            + 新建接口
          </button>
        </div>

        <div v-if="projectApis.length === 0" class="lc-apis__empty">
          <span class="lc-apis__empty-title">这个项目还没有登记接口</span>
          <span>把跨页面复用的接口抽到这里，页面里就只需要选名字。</span>
          <button type="button" class="lc-apis__primary lc-apis__primary--sm" @click="goNew">
            登记第一个接口
          </button>
        </div>
        <div v-else-if="filtered.length === 0" class="lc-apis__empty">
          <span class="lc-apis__empty-title">没有匹配的接口</span>
          <span>换个关键词试试，搜索覆盖名称、地址、说明与标签。</span>
        </div>

        <ul v-else class="lc-apis__cards">
          <li
            v-for="api in pageRows"
            :key="api.id"
            class="lc-apis__card"
            :class="{
              'is-active': !isNewRoute && selected?.id === api.id,
              'is-dragging': dragId === api.id,
            }"
            @dragover="onDragOver"
            @drop="onDrop(api, $event)"
          >
            <button type="button" class="lc-apis__card-main" @click="select(api.id)">
              <span class="lc-apis__method" :data-method="api.method">{{
                METHOD_SHORT[api.method]
              }}</span>
              <span class="lc-apis__card-text">
                <span class="lc-apis__card-name">{{ api.name }}</span>
                <code class="lc-apis__card-path">{{ api.path }}</code>
              </span>
            </button>
            <button
              type="button"
              class="lc-apis__grip"
              :draggable="search.trim() === ''"
              :aria-label="`拖拽调整 ${api.name} 的顺序`"
              :title="search.trim() === '' ? '拖拽排序' : '搜索时不能排序'"
              @dragstart="onDragStart(api, $event)"
              @dragend="onDragEnd"
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="9" cy="6" r="1.5" />
                <circle cx="15" cy="6" r="1.5" />
                <circle cx="9" cy="12" r="1.5" />
                <circle cx="15" cy="12" r="1.5" />
                <circle cx="9" cy="18" r="1.5" />
                <circle cx="15" cy="18" r="1.5" />
              </svg>
            </button>
          </li>
        </ul>

        <div v-if="pageCount > 1" class="lc-apis__pager" aria-label="分页">
          <button
            type="button"
            class="lc-apis__page"
            :disabled="page === 1"
            aria-label="上一页"
            @click="page -= 1"
          >
            ‹
          </button>
          <template v-for="(p, index) in pageList" :key="index">
            <span v-if="p === 0" class="lc-apis__ellipsis">…</span>
            <button
              v-else
              type="button"
              class="lc-apis__page"
              :class="{ 'is-active': p === page }"
              :aria-current="p === page ? 'page' : undefined"
              @click="page = p"
            >
              {{ p }}
            </button>
          </template>
          <button
            type="button"
            class="lc-apis__page"
            :disabled="page === pageCount"
            aria-label="下一页"
            @click="page += 1"
          >
            ›
          </button>
        </div>
      </aside>

      <section class="lc-apis__detail">
        <ApiDetail
          v-if="activeDraft && activeResultDraft && (selected !== null || isNewRoute)"
          :key="activeKey"
          :draft="activeDraft"
          :result-draft="activeResultDraft"
          :saved="selected"
          :project-id="projectId"
          :is-new="isNewRoute"
          @saved="onSaved"
          @removed="onRemoved"
          @reset="onReset"
          @capture="onCapture"
        />

        <div v-else-if="isMissing" class="lc-apis__placeholder">
          <span class="lc-apis__placeholder-title">接口不存在</span>
          <span>它可能已被删除，链接中的 id 不正确，或者归在别的项目里。</span>
          <button type="button" class="lc-apis__ghost" @click="goList">返回接口列表</button>
        </div>

        <div v-else class="lc-apis__placeholder">
          <span class="lc-apis__placeholder-title">从左侧选择一个接口，或新建一个</span>
          <span>接口保存后登记在项目里，页面在「页面数据」中按名字引用，改一次处处生效。</span>
          <button type="button" class="lc-apis__primary" @click="goNew">+ 新建接口</button>
        </div>
      </section>
    </div>

    <Teleport to="body">
      <div v-if="helpOpen" class="lc-apis-help" @mousedown.self="helpOpen = false">
        <section
          class="lc-apis-help__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="lc-apis-help-title"
        >
          <header class="lc-apis-help__head">
            <h2 id="lc-apis-help-title" class="lc-apis-help__title">接口管理使用文档</h2>
            <button
              type="button"
              class="lc-apis-help__close"
              aria-label="关闭使用文档"
              @click="helpOpen = false"
            >
              ×
            </button>
          </header>
          <div class="lc-apis-help__body">
            <section>
              <h3>接口是项目级资产</h3>
              <p>
                接口在这里登记一次，页面在「页面数据」里按名字引用。改一次定义，所有引用它的页面在下一次装载时都用新地址；仍被引用的接口不能删除，需先在页面里解绑。
              </p>
            </section>
            <section>
              <h3>全局配置与环境</h3>
              <p>
                域名、默认头、凭据与响应头登记按环境保存，同一时刻只有一套生效。相对路径的接口按生效环境拼域名，绝对地址不拼。卡片上的开关就地生效，「编辑配置」打开完整编辑；预览非生效环境时可「设为当前」，已打开页面的接口数据会重新取一次。
              </p>
            </section>
            <section>
              <h3>凭据（Token）</h3>
              <p>
                开启后选择一条项目接口当登录接口，并填写 token
                在响应里的路径；请求前自动取票注入请求头，命中 401
                会重取并重发一次（可在「其他配置」关闭自动重试）。
              </p>
            </section>
            <section>
              <h3>编辑与调试</h3>
              <p>
                右侧四个页签：基本配置（名称 / 地址 / 方法 / 标签 / 分组 /
                公开标记）、请求配置（请求头与参数）、响应配置（样本与结果类型）、高级配置（凭据、调试与删除）。调试用的是表单上当前的定义，不必先保存；「用这次响应填充样本与类型」可把真实响应反推成补全用的类型。
              </p>
            </section>
            <section>
              <h3>登记信息与请求的边界</h3>
              <p>
                标签、公开标记、参数的类型 / 必填 /
                说明、响应头登记都是设计期信息，随定义保存与导出，不参与真实请求；请求只按方法、地址、请求头、参数默认值与请求体发送。
              </p>
            </section>
          </div>
        </section>
      </div>
    </Teleport>
  </main>
</template>

<style scoped>
.lc-apis {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 22px 28px 26px;
  overflow: hidden;
}

.lc-apis__head {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.lc-apis__title {
  margin: 0 0 4px;
  color: var(--lc-text);
  font-size: 22px;
  font-weight: 650;
  letter-spacing: 0.5px;
}

.lc-apis__subtitle {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 13px;
}

.lc-apis__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
}

.lc-apis__docs {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--lc-motion-fast) var(--lc-ease-out);
}

.lc-apis__docs:hover {
  border-color: var(--lc-border-strong);
}

.lc-apis__primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--lc-accent);
  border-radius: var(--lc-radius-sm);
  background: linear-gradient(
    135deg,
    var(--lc-accent-bright),
    var(--lc-accent) 52%,
    var(--lc-accent-2)
  );
  box-shadow: 0 0 16px var(--lc-glow-soft);
  color: var(--lc-on-accent);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition:
    border-color var(--lc-motion-fast) var(--lc-ease-out),
    box-shadow var(--lc-motion-fast) var(--lc-ease-out);
}

.lc-apis__primary:hover {
  border-color: var(--lc-accent-bright);
  box-shadow: 0 0 22px var(--lc-glow);
}

.lc-apis__primary--sm {
  height: 30px;
  padding: 0 12px;
}

.lc-apis__body {
  display: grid;
  flex: 1;
  grid-template-columns: 340px minmax(0, 1fr);
  gap: 16px;
  min-height: 0;
}

.lc-apis__list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(165deg, var(--lc-surface), var(--lc-surface-sunken));
}

.lc-apis__list-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 10px;
}

.lc-apis__search {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 7px;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-muted);
  transition: border-color var(--lc-motion-fast) var(--lc-ease-out);
}

.lc-apis__search:focus-within {
  border-color: var(--lc-accent);
  box-shadow: 0 0 0 2px var(--lc-accent-soft);
}

.lc-apis__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}

.lc-apis__search-input::placeholder {
  color: var(--lc-text-muted);
}

.lc-apis__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin: 6px 12px 14px;
  padding: 30px 16px;
  border: 1px dashed var(--lc-border);
  border-radius: var(--lc-radius-md);
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

.lc-apis__empty-title {
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
}

.lc-apis__cards {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  margin: 0;
  padding: 2px 12px 12px;
  overflow-y: auto;
  list-style: none;
  scrollbar-width: thin;
  scrollbar-color: var(--lc-border-strong) transparent;
}

.lc-apis__cards::-webkit-scrollbar {
  width: 8px;
}

.lc-apis__cards::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: var(--lc-border-strong);
}

.lc-apis__card {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: linear-gradient(150deg, var(--lc-surface-raised), var(--lc-surface));
  transition:
    border-color var(--lc-motion-fast) var(--lc-ease-out),
    box-shadow var(--lc-motion-fast) var(--lc-ease-out),
    opacity var(--lc-motion-fast) var(--lc-ease-out);
}

.lc-apis__card:hover {
  border-color: var(--lc-border-strong);
}

.lc-apis__card.is-active,
.lc-apis__card.is-active:hover {
  border-color: var(--lc-accent);
  background: linear-gradient(
    150deg,
    color-mix(in srgb, var(--lc-accent) 14%, var(--lc-surface-raised)),
    var(--lc-surface)
  );
  box-shadow:
    0 0 0 1px var(--lc-accent-soft),
    0 0 18px var(--lc-glow-soft);
}

.lc-apis__card.is-dragging {
  opacity: 0.5;
}

.lc-apis__card-main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 10px 8px 10px 12px;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.lc-apis__method {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  height: 22px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--lc-accent);
  color: var(--lc-on-accent);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 10px;
  font-weight: 700;
}

.lc-apis__method[data-method='POST'] {
  background: var(--lc-success);
}

.lc-apis__method[data-method='PUT'] {
  background: var(--lc-warning);
}

.lc-apis__method[data-method='DELETE'] {
  background: var(--lc-danger);
}

.lc-apis__method[data-method='PATCH'] {
  background: var(--lc-accent-2);
}

.lc-apis__card-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.lc-apis__card-name {
  overflow: hidden;
  color: var(--lc-text);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-apis__card.is-active .lc-apis__card-name {
  color: var(--lc-accent-bright);
}

.lc-apis__card-path {
  overflow: hidden;
  color: var(--lc-text-muted);
  font-family: 'JetBrains Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-apis__grip {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-right: 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--lc-text-muted);
  cursor: grab;
  opacity: 0.6;
}

.lc-apis__grip:hover {
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
  opacity: 1;
}

.lc-apis__grip:active {
  cursor: grabbing;
}

.lc-apis__pager {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 12px 14px;
}

.lc-apis__page {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: none;
  color: var(--lc-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-apis__page:hover:not(:disabled) {
  border-color: var(--lc-border-strong);
  color: var(--lc-text);
}

.lc-apis__page.is-active {
  border-color: var(--lc-accent);
  background: var(--lc-accent-soft);
  color: var(--lc-accent-bright);
  font-weight: 600;
}

.lc-apis__page:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.lc-apis__ellipsis {
  color: var(--lc-text-muted);
  font-size: 12px;
}

.lc-apis__detail {
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-md);
  background: linear-gradient(165deg, var(--lc-surface), var(--lc-surface-sunken));
}

.lc-apis__placeholder {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px 28px;
  color: var(--lc-text-secondary);
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
}

.lc-apis__placeholder-title {
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-apis__ghost {
  display: inline-flex;
  align-items: center;
  height: 30px;
  margin-top: 6px;
  padding: 0 14px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-panel-glass);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.lc-apis__ghost:hover {
  border-color: var(--lc-border-strong);
  color: var(--lc-accent-bright);
}

.lc-apis :focus-visible {
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

/* 使用文档弹框 */
.lc-apis-help {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(2, 8, 20, 0.62);
  backdrop-filter: blur(3px);
}

.lc-apis-help__panel {
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: min(86vh, 820px);
  overflow: hidden;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-surface);
  box-shadow: var(--lc-shadow);
}

.lc-apis-help__head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-apis-help__title {
  margin: 0;
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 650;
}

.lc-apis-help__close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: none;
  color: var(--lc-text-secondary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.lc-apis-help__close:hover {
  border-color: var(--lc-border-strong);
  color: var(--lc-text);
}

.lc-apis-help__body {
  flex: 1;
  min-height: 0;
  padding: 14px 18px 18px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--lc-border-strong) transparent;
}

.lc-apis-help__body section {
  margin-bottom: 14px;
}

.lc-apis-help__body h3 {
  margin: 0 0 4px;
  color: var(--lc-accent-bright);
  font-size: 13px;
  font-weight: 600;
}

.lc-apis-help__body p {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 12px;
  line-height: 1.7;
}

@media (max-width: 1100px) {
  .lc-apis__body {
    grid-template-columns: 280px minmax(0, 1fr);
  }
}

@media (max-width: 900px) {
  .lc-apis {
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--lc-border-strong) transparent;
  }

  .lc-apis__body {
    grid-template-columns: minmax(0, 1fr);
  }

  .lc-apis__list {
    max-height: 360px;
  }

  .lc-apis__detail {
    min-height: 540px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lc-apis__primary,
  .lc-apis__docs,
  .lc-apis__card,
  .lc-apis__search {
    transition: none;
  }

  .lc-apis-help {
    backdrop-filter: none;
  }
}
</style>
