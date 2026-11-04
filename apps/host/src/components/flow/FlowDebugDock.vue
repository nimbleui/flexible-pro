<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { formatJsonValue, parseJsonDraft } from '@lc/shared'
import { statusLabel } from './composables/use-flow-debug'
import type {
  FlowLogLine,
  FlowNodeTiming,
  FlowRunRecord,
  useFlowDebug,
} from './composables/use-flow-debug'
import './styles/dock.css'

/** 面板的四个视图；id 同时用作 ARIA 关联的 key，新增视图不必改模板 */
type DockTabId = 'logs' | 'scope' | 'records' | 'perf'

const DOCK_TABS: readonly { id: DockTabId; label: string }[] = [
  { id: 'logs', label: '运行日志' },
  { id: 'scope', label: '调试信息' },
  { id: 'records', label: '执行记录' },
  { id: 'perf', label: '性能监控' },
]

/** 距底部不足这个距离才算「原本就贴着底部」；用户翻上去看旧日志时不该被拽回底部 */
const STICK_TO_BOTTOM_PX = 32

const props = defineProps<{
  /** useFlowDebug(editor) 的返回值 */
  debug: ReturnType<typeof useFlowDebug>
}>()

const emit = defineEmits<{ close: [] }>()

/**
 * `debug` 是 composable 的返回值，成员全是 ref / computed。
 *
 * 模板只对**顶层**绑定自动解包，普通对象里的 ref 不会解包，所以在这里先拆成局部绑定：
 * 模板直接写 `logs`，脚本里继续用 `.value`。
 */
const {
  logs,
  records,
  timings,
  summary,
  running,
  scope,
  initialInput,
  stepAnimation,
  setInitialInput,
  totalDuration,
  slowestNode,
} = props.debug

/**
 * 试运行输入的本地草稿。
 *
 * 只在 change / 失焦时写回 composable：这是「下一次运行用什么数据」的编辑器，
 * 逐字符提交会让一次输入变成几十次无效写入，而中间态根本不是合法 JSON。
 */
const inputDraft = ref(formatJsonValue(initialInput.value))
const inputError = ref('')

/** 只有对象才是可用的变量表；数组与标量会让 `{{ a.b }}` 的读取形状无从谈起 */
function isVariableTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function commitInputDraft(): void {
  const parsed = parseJsonDraft(inputDraft.value)
  if (!parsed.ok) {
    inputError.value = parsed.error
    return
  }

  if (parsed.value === undefined) {
    setInitialInput({})
    inputError.value = ''
    inputDraft.value = '{}'
    return
  }

  if (!isVariableTable(parsed.value)) {
    inputError.value = '试运行输入必须是一个对象，例如 { "amount": 2580 }'
    return
  }

  setInitialInput(parsed.value)
  inputError.value = ''
}

const activeTab = ref<DockTabId>('logs')

/** 滚动容器；面板用 v-show 切换，元素始终存在，切回「运行日志」时仍停在底部 */
const logListRef = ref<HTMLElement | null>(null)

/** 变量表；`state.reset` 会留下值为 undefined 的键，这里仍要显示出来 */
const scopeEntries = computed(() =>
  Object.entries(scope.value).map(([key, value]) => ({ key, value: stringifyVariable(value) })),
)

/** 耗时条按最慢节点归一化；`slowestNode` 已由 composable 算好，不再扫一遍 timings */
const perfBars = computed(() => {
  const maxMs = slowestNode.value?.durationMs ?? 0

  return timings.value.map((timing) => ({
    ...timing,
    percent: maxMs > 0 ? Math.round((timing.durationMs / maxMs) * 100) : 0,
  }))
})

/**
 * 新日志到达后把列表滚到底。
 *
 * watcher 默认 pre-flush，回调里读到的是**追加前**的几何信息，正好用来判断用户是否贴着
 * 底部；`nextTick` 等本次 DOM 更新完成后再写 `scrollTop`，因此不需要 `setTimeout` 去猜
 * 一个延后毫秒数。
 */
const stopAutoScroll = watch(
  () => logs.value.length,
  () => {
    const list = logListRef.value
    if (!list) return

    if (list.scrollHeight - list.scrollTop - list.clientHeight > STICK_TO_BOTTOM_PX) return

    void nextTick(() => {
      list.scrollTop = list.scrollHeight
    })
  },
)

onBeforeUnmount(stopAutoScroll)

/**
 * 变量值是表达式求出来的任意 JSON。
 *
 * `JSON.stringify` 对 `undefined` 与函数返回 `undefined`，遇到循环引用会抛错；两种情况
 * 都退回 `String(value)`，保证一个坏值不会让整张变量表消失。
 */
function stringifyVariable(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 日志圆点的颜色修饰符；tone 由 composable 决定，这里只做类名映射 */
function dotClass(tone: FlowLogLine['tone']): string {
  return `lc-flow-dock__dot--${tone}`
}

/**
 * 语义状态修饰符。
 *
 * 结果判别与节点走向在视觉上只有「成功 / 失败 / 中性」三档，统一成 `is-*` 后颜色只写在
 * CSS 的一处，概要卡、执行记录与耗时条共用同一套映射。
 */
function semanticClass(value: FlowRunRecord['status'] | FlowNodeTiming['outcome']): string {
  return `is-${value}`
}

/** 页签键盘导航：方向键在四个视图间循环，Home / End 跳到首尾，与外壳属性面板一致 */
function onTabKeydown(event: KeyboardEvent, index: number): void {
  if (
    event.key !== 'ArrowRight' &&
    event.key !== 'ArrowLeft' &&
    event.key !== 'Home' &&
    event.key !== 'End'
  ) {
    return
  }

  event.preventDefault()

  const last = DOCK_TABS.length - 1
  let next = index
  if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1
  else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1
  else if (event.key === 'Home') next = 0
  else next = last

  activeTab.value = DOCK_TABS[next].id
  const tablist = (event.currentTarget as HTMLElement | null)?.closest('[role="tablist"]')
  tablist?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
}
</script>

<template>
  <section class="lc-flow-dock" aria-label="流程调试">
    <header class="lc-flow-dock__bar">
      <div class="lc-flow-dock__tabs" role="tablist" aria-label="调试视图">
        <button
          v-for="(tab, index) in DOCK_TABS"
          :id="`lc-flow-dock-tab-${tab.id}`"
          :key="tab.id"
          type="button"
          role="tab"
          class="lc-flow-dock__tab"
          :class="{ 'is-active': activeTab === tab.id }"
          :aria-selected="activeTab === tab.id"
          :aria-controls="`lc-flow-dock-panel-${tab.id}`"
          :tabindex="activeTab === tab.id ? 0 : -1"
          @click="activeTab = tab.id"
          @keydown="onTabKeydown($event, index)"
        >
          {{ tab.label }}
        </button>
      </div>

      <span v-if="running" class="lc-flow-dock__running" role="status">
        <span class="lc-flow-dock__running-dot" aria-hidden="true" />
        执行中…
      </span>

      <!-- 步进动画开关：二三十步的流程按节拍播要等好几秒，回看结果时这层等待没有价值 -->
      <label
        class="lc-flow-dock__beat"
        title="关掉后每一步即时落地，长流程回看不必等动画；节点耗时统计不受影响"
      >
        <input v-model="stepAnimation" type="checkbox" />
        <span>步进动画</span>
      </label>

      <button
        type="button"
        class="lc-icon-button lc-flow-dock__close"
        aria-label="关闭调试面板"
        @click="emit('close')"
      >
        ×
      </button>
    </header>

    <div class="lc-flow-dock__main">
      <div class="lc-flow-dock__panels">
        <div
          v-show="activeTab === 'logs'"
          id="lc-flow-dock-panel-logs"
          ref="logListRef"
          class="lc-flow-dock__panel"
          role="tabpanel"
          aria-labelledby="lc-flow-dock-tab-logs"
        >
          <ul v-if="logs.length > 0" class="lc-flow-dock__logs">
            <li v-for="line in logs" :key="line.id" class="lc-flow-dock__log-row">
              <span class="lc-flow-dock__dot" :class="dotClass(line.tone)" aria-hidden="true" />
              <time class="lc-flow-dock__log-time">{{ line.time }}</time>
              <span class="lc-flow-dock__log-message">{{ line.message }}</span>
            </li>
          </ul>
          <div v-else class="lc-flow-dock__empty">
            <span class="lc-flow-dock__empty-title">暂无运行日志</span>
            <span class="lc-flow-dock__empty-hint">试运行后，每个节点的结果会逐行写在这里</span>
          </div>
        </div>

        <div
          v-show="activeTab === 'scope'"
          id="lc-flow-dock-panel-scope"
          class="lc-flow-dock__panel"
          role="tabpanel"
          aria-labelledby="lc-flow-dock-tab-scope"
        >
          <div class="lc-flow-dock__input">
            <label class="lc-flow-dock__input-label" for="lc-flow-dock-test-input">
              试运行输入
            </label>
            <textarea
              id="lc-flow-dock-test-input"
              v-model="inputDraft"
              class="lc-flow-dock__input-area"
              rows="5"
              spellcheck="false"
              @change="commitInputDraft"
              @blur="commitInputDraft"
            ></textarea>
            <p v-if="inputError" class="lc-flow-dock__input-error">{{ inputError }}</p>
            <p v-else class="lc-flow-dock__input-hint">
              下一次运行的初始变量表；「设置变量」节点写在它之上，不进文档也不参与发布。
            </p>
          </div>

          <dl v-if="scopeEntries.length > 0" class="lc-flow-dock__scope">
            <div v-for="entry in scopeEntries" :key="entry.key" class="lc-flow-dock__scope-row">
              <dt class="lc-flow-dock__scope-key">{{ entry.key }}</dt>
              <dd class="lc-flow-dock__scope-value">{{ entry.value }}</dd>
            </div>
          </dl>
          <div v-else class="lc-flow-dock__empty">
            <span class="lc-flow-dock__empty-title">暂无变量</span>
            <span class="lc-flow-dock__empty-hint">「设置变量」节点执行后写入这里</span>
          </div>
        </div>

        <div
          v-show="activeTab === 'records'"
          id="lc-flow-dock-panel-records"
          class="lc-flow-dock__panel"
          role="tabpanel"
          aria-labelledby="lc-flow-dock-tab-records"
        >
          <table v-if="records.length > 0" class="lc-flow-dock__table">
            <thead>
              <tr>
                <th scope="col">实例号</th>
                <th scope="col">结果</th>
                <th scope="col" class="lc-flow-dock__cell--num">步数</th>
                <th scope="col" class="lc-flow-dock__cell--num">耗时</th>
                <th scope="col">开始时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="record in records" :key="record.instanceId">
                <th scope="row" class="lc-flow-dock__cell--id" :title="record.instanceId">
                  {{ record.instanceId }}
                </th>
                <td
                  class="lc-flow-dock__status"
                  :class="semanticClass(record.status)"
                  :title="record.message"
                >
                  {{ statusLabel(record.status) }}
                </td>
                <td class="lc-flow-dock__cell--num">{{ record.steps }}</td>
                <td class="lc-flow-dock__cell--num">{{ record.durationMs }}ms</td>
                <td class="lc-flow-dock__mono">{{ record.startedAt }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="lc-flow-dock__empty">
            <span class="lc-flow-dock__empty-title">暂无执行记录</span>
            <span class="lc-flow-dock__empty-hint">每次试运行都会留档，最多保留 20 条</span>
          </div>
        </div>

        <div
          v-show="activeTab === 'perf'"
          id="lc-flow-dock-panel-perf"
          class="lc-flow-dock__panel"
          role="tabpanel"
          aria-labelledby="lc-flow-dock-tab-perf"
        >
          <template v-if="perfBars.length > 0">
            <div class="lc-flow-dock__metrics">
              <div class="lc-flow-dock__metric">
                <span class="lc-flow-dock__metric-label">节点耗时合计</span>
                <strong class="lc-flow-dock__metric-value">
                  {{ totalDuration }}<span class="lc-flow-dock__metric-unit">ms</span>
                </strong>
              </div>
              <div v-if="slowestNode" class="lc-flow-dock__metric">
                <span class="lc-flow-dock__metric-label">最慢节点</span>
                <strong class="lc-flow-dock__metric-value" :title="slowestNode.label">
                  {{ slowestNode.label }}
                  <span class="lc-flow-dock__metric-unit">{{ slowestNode.durationMs }}ms</span>
                </strong>
              </div>
            </div>

            <ul class="lc-flow-dock__bars">
              <li
                v-for="(bar, index) in perfBars"
                :key="`${bar.nodeId}-${index}`"
                class="lc-flow-dock__bar-row"
              >
                <span class="lc-flow-dock__bar-label" :title="bar.label">{{ bar.label }}</span>
                <span class="lc-flow-dock__bar-track">
                  <span
                    class="lc-flow-dock__bar-fill"
                    :class="semanticClass(bar.outcome)"
                    :style="{ width: `${bar.percent}%` }"
                  />
                </span>
                <span class="lc-flow-dock__bar-value">{{ bar.durationMs }}ms</span>
              </li>
            </ul>
          </template>
          <div v-else class="lc-flow-dock__empty">
            <span class="lc-flow-dock__empty-title">暂无耗时统计</span>
            <span class="lc-flow-dock__empty-hint">试运行结束后按节点列出耗时</span>
          </div>
        </div>
      </div>

      <aside
        class="lc-flow-dock__summary"
        :class="summary ? semanticClass(summary.status) : null"
        aria-label="本次执行概要"
      >
        <template v-if="summary">
          <div class="lc-flow-dock__summary-head">
            <span
              class="lc-flow-dock__mark"
              :class="semanticClass(summary.status)"
              aria-hidden="true"
            />
            <span class="lc-flow-dock__summary-title">{{ statusLabel(summary.status) }}</span>
          </div>

          <dl class="lc-flow-dock__facts">
            <div class="lc-flow-dock__fact">
              <dt>耗时</dt>
              <dd class="lc-flow-dock__mono">{{ summary.durationMs }}ms</dd>
            </div>
            <div class="lc-flow-dock__fact">
              <dt>执行实例</dt>
              <dd class="lc-flow-dock__mono" :title="summary.instanceId">
                {{ summary.instanceId }}
              </dd>
            </div>
            <div class="lc-flow-dock__fact">
              <dt>开始时间</dt>
              <dd class="lc-flow-dock__mono">{{ summary.startedAt }}</dd>
            </div>
            <div class="lc-flow-dock__fact">
              <dt>结束时间</dt>
              <dd class="lc-flow-dock__mono">{{ summary.endedAt }}</dd>
            </div>
          </dl>

          <button type="button" class="lc-flow-dock__detail" :title="summary.instanceId">
            查看详情 →
          </button>
        </template>

        <p v-else class="lc-flow-dock__summary-empty">
          暂无执行概要，运行一次事件链后这里显示本次结果
        </p>
      </aside>
    </div>
  </section>
</template>
