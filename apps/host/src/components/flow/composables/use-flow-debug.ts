import { computed, ref, shallowRef } from 'vue'
import type { ActionStepRecord } from '@lc/contracts'
import type { ActionHandler, ActionRunResult } from '@lc/contracts'
import type { ExpressionScope, FlowDefinition } from '@lc/schema'
import {
  APPROVAL_SUBMIT,
  DATA_CACHE,
  DATA_FORMAT,
  DATA_MAPPING,
  DATA_VALIDATE,
  ERROR_HANDLE,
  FLOW_DELAY,
  FLOW_EXPRESSION,
  FLOW_FILTER,
  FLOW_LOOP,
  FLOW_MERGE,
  FLOW_SCRIPT,
  FLOW_SPLIT,
  FLOW_SUBFLOW,
  FLOW_TRANSFORM,
  FLOW_TRIGGER,
  FLOW_WAIT,
  HTTP_REQUEST,
  LOG_RECORD,
  PRECONDITION,
  RETRY_POLICY,
  STATE_GET,
} from '@lc/schema'
import { FLOW_HANDLERS, runFlowGraph } from '@lc/service-action'
import { useAppContext } from '@lc/vue'
import { toastService } from '../../../toast'
import type { FlowEditorHandle } from './use-flow-editor'

/**
 * 流程试运行。
 *
 * 走的是运行时同一个图执行器（`@lc/service-action` 的 `runFlowGraph`），条件求值也用
 * 应用级表达式引擎，所以「设计器里跑通」与「运行时跑通」是同一套判定，不是两套。
 *
 * 差别在处理器：设计器里没有页面状态服务、没有数据源、也不会真的发请求或跳路由。
 * 因此这里分两类——
 *  - **真实执行**：读写一份本次运行独有的变量表、弹一条真实提示、真的等一段时间；
 *  - **模拟执行**：需要外部系统（审批、HTTP、子流程……）的节点按成功返回，
 *    并在日志里明确写出「模拟」。
 * 模拟不是假装成功：日志与调试信息都带 `simulated` 标记，面板顶部也有说明，
 * 作者不会把一次试运行误读成一次真实调用。
 */

/** 一条运行日志 */
export interface FlowLogLine {
  /** 序号，作为列表 key */
  id: number
  /** 时间戳（本地化文本） */
  time: string
  /** 圆点颜色语义 */
  tone: 'info' | 'success' | 'warning' | 'error' | 'running'
  /** 日志正文 */
  message: string
}

/** 一次执行记录（供「执行记录」列表回看） */
export interface FlowRunRecord {
  /** 执行实例号 */
  instanceId: string
  /** 结果判别 */
  status: ActionRunResult['status']
  /** 步数 */
  steps: number
  /** 总耗时（毫秒） */
  durationMs: number
  /** 开始时刻文本 */
  startedAt: string
  /** 结束时刻文本 */
  endedAt: string
  /** 失败原因 */
  message?: string
}

/** 单个节点的耗时统计 */
export interface FlowNodeTiming {
  nodeId: string
  label: string
  durationMs: number
  outcome: ActionStepRecord['outcome']
}

/** 模拟执行的固定耗时，让试运行的时间轴不至于全是 0ms */
const SIMULATED_LATENCY_MS = 40

/** 日志保留条数上限 */
const LOG_STACK_LIMIT = 300

/**
 * 一步动画的节拍（毫秒）。
 *
 * 步进引擎在 `handler.execute` 外面计时，任何塞进处理器的 `await` 都会被算进
 * `durationMs`，「性能监控」里的耗时就不再是真实耗时。所以节拍只作用于呈现侧：
 * 执行照常全速跑，跑出来的步记录进队列，由播放器按这个节拍逐个落地。
 * 260ms 是「来得及看清这一步是谁」的下限，再长就会让十步的流程等得焦躁。
 */
const STEP_BEAT_MS = 260

/** 节拍里「执行中」占的比例，剩下的给「落定」的视觉反馈 */
const STEP_RUNNING_SHARE = 0.55

/** 队列暂时为空、但执行还没结束时播放器的小睡时长 */
const PLAYBACK_IDLE_MS = 30

/**
 * 试运行输入的初值，与内置示例流程对齐。
 *
 * 只在「还没有编辑过输入」时出现，作者改成自己的数据后不会再被覆盖。
 */
const DEFAULT_TEST_INPUT: Record<string, unknown> = {
  formData: { orderId: 'SO-2026-1127', amount: 2580 },
  orderId: 'SO-2026-1127',
  amount: 2580,
}

/** 需要外部系统、在设计器里按模拟处理的节点类型 */
const SIMULATED_TYPES: readonly string[] = [
  APPROVAL_SUBMIT,
  HTTP_REQUEST,
  DATA_VALIDATE,
  DATA_FORMAT,
  DATA_CACHE,
  DATA_MAPPING,
  ERROR_HANDLE,
  RETRY_POLICY,
  PRECONDITION,
  FLOW_SUBFLOW,
  FLOW_SCRIPT,
  FLOW_FILTER,
  FLOW_TRANSFORM,
  FLOW_MERGE,
  FLOW_SPLIT,
  FLOW_EXPRESSION,
  FLOW_LOOP,
  FLOW_WAIT,
  'dataSource.fetch',
  'plugin.invoke',
  'navigation.go',
]

/** 把时间格式化成 `16:30:12` 这种日志前缀 */
function formatClock(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

/** 生成执行实例号；与运行时日志对齐用，不参与任何业务判断 */
function createInstanceId(date: Date): string {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join('')

  return `exec_${stamp}_${String(Math.floor(Math.random() * 900) + 100)}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function useFlowDebug(editor: FlowEditorHandle) {
  const context = useAppContext()
  const expression = context.expression

  const logs = ref<FlowLogLine[]>([])
  const records = ref<FlowRunRecord[]>([])
  const timings = shallowRef<FlowNodeTiming[]>([])
  const running = ref(false)
  const summary = shallowRef<FlowRunRecord | null>(null)

  /** 已经落定的节点状态；由播放器逐步写入，画布的描边色与流动连线都读它 */
  const stepStates = shallowRef<Record<string, FlowNodeTiming['outcome']>>({})

  /** 正在播放的那一步；对应节点显示「执行中」 */
  const currentNodeId = ref<string | null>(null)

  /**
   * 本次运行是否已经播完落定。
   *
   * 「没走到」的节点与分支只有在这一刻才说得上：执行途中每个下游都只是「还没轮到」，
   * 提前把它们涂成未到达色，等于在跑的过程中就宣布结果。
   */
  const settled = ref(false)

  /**
   * 步进动画开关。
   *
   * 关掉后每一步即时落地，日志与状态不再等节拍。二三十步的流程按 260ms 播要等七八秒，
   * 回看结果时这个等待没有价值，但真实耗时统计必须照旧准确——所以开关只作用于播放器。
   */
  const stepAnimation = ref(true)

  /**
   * 试运行输入变量表。
   *
   * 设计器里没有页面状态服务，图上的 `state.get` 无米下锅——不预置一份输入，示例流程
   * 第一次运行就会在条件节点上失败，那条失败信息（`undefined` 上没有 `amount`）虽然
   * 正确，却把「你的表达式写错了」和「你还没给测试数据」混成了一件事。
   * 所以这里给的是**可编辑的测试输入**，运行前拷进作用域；它不进文档、不参与发布。
   */
  const initialInput = ref<Record<string, unknown>>({ ...DEFAULT_TEST_INPUT })
  const scope = ref<Record<string, unknown>>({})

  let sequence = 0
  let aborted = false

  /** 覆盖试运行输入；只接受对象，其他形状由调用方的 JSON 解析挡在外面 */
  function setInitialInput(value: Record<string, unknown>): void {
    initialInput.value = { ...value }
  }

  /** 节点显示名：优先作者改过的 name，其次目录标题，最后退回 id */
  function nodeLabel(flow: FlowDefinition, record: ActionStepRecord): string {
    const node = flow.nodes[record.actionId]

    return node?.name ?? node?.id ?? record.actionId
  }

  function pushLog(tone: FlowLogLine['tone'], message: string): void {
    sequence += 1
    const next = [...logs.value, { id: sequence, time: formatClock(new Date()), tone, message }]

    // 超限丢最旧的：一次会话里反复试运行会让数组无界增长，而面板一屏也只能看到几十行
    logs.value =
      next.length > LOG_STACK_LIMIT ? next.slice(next.length - LOG_STACK_LIMIT) : next
  }

  /**
   * 构造本次运行的作用域。
   *
   * `data` 是表达式里读变量的命名空间（`{{ data.orderId }}`），与页面运行时
   * `buildPageData` 产出的形状保持一致，作者在设计器里写的表达式搬到页面上不会失效。
   */
  function createScope(): ExpressionScope {
    return { data: { ...scope.value }, ...scope.value }
  }

  /** 把求值结果写回变量表；`assignTo` 缺省时按 `key` 落 */
  function writeVariable(target: unknown, value: unknown): void {
    if (typeof target !== 'string' || target === '') return
    scope.value = { ...scope.value, [target]: value }
  }

  function buildHandlers(): Map<string, ActionHandler> {
    const handlers = new Map<string, ActionHandler>()

    for (const handler of FLOW_HANDLERS) handlers.set(handler.type, handler)

    handlers.set(FLOW_TRIGGER, {
      type: FLOW_TRIGGER,
      async execute({ config }) {
        const eventName = typeof config.eventName === 'string' ? config.eventName : ''
        pushLog('info', `事件触发：${eventName || '未命名事件'}`)
      },
    })

    handlers.set(STATE_GET, {
      type: STATE_GET,
      async execute({ config }) {
        const key = typeof config.key === 'string' ? config.key : ''
        writeVariable(config.assignTo ?? key, scope.value[key])
      },
    })

    handlers.set('state.set', {
      type: 'state.set',
      async execute({ config }) {
        writeVariable(config.key, config.value)
      },
    })

    handlers.set('state.reset', {
      type: 'state.reset',
      async execute({ config }) {
        const key = typeof config.key === 'string' ? config.key : ''
        scope.value = key === '' ? {} : { ...scope.value, [key]: undefined }
      },
    })

    handlers.set('ui.toast', {
      type: 'ui.toast',
      async execute({ config }) {
        const message = typeof config.message === 'string' ? config.message : ''
        const level = typeof config.level === 'string' ? config.level : 'info'

        toastService.show(message, level as 'info' | 'success' | 'warning' | 'error')
      },
    })

    handlers.set(LOG_RECORD, {
      type: LOG_RECORD,
      async execute({ config }) {
        const message = typeof config.message === 'string' ? config.message : ''
        const level = typeof config.level === 'string' ? config.level : 'info'

        pushLog(level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info', message)
      },
    })

    handlers.set(FLOW_DELAY, {
      type: FLOW_DELAY,
      async execute({ config }) {
        const ms = Number(config.milliseconds)
        if (Number.isFinite(ms) && ms > 0) await delay(Math.min(ms, 5000))
      },
    })

    for (const type of SIMULATED_TYPES) {
      handlers.set(type, {
        type,
        async execute() {
          await delay(SIMULATED_LATENCY_MS)
        },
      })
    }

    return handlers
  }

  /** 把一条步记录翻译成日志文本 */
  function describeStep(flow: FlowDefinition, record: ActionStepRecord): void {
    const label = nodeLabel(flow, record)

    if (record.outcome === 'skipped') {
      pushLog('warning', `节点「${label}」条件不成立，已跳过`)
      return
    }

    if (record.outcome === 'failed') {
      pushLog('error', `节点「${label}」执行失败：${record.message ?? '未知原因'}`)
      return
    }

    const suffix = record.message ? `，返回: ${record.message}` : ''
    const simulated = SIMULATED_TYPES.includes(record.type) ? '（模拟，未发起真实调用）' : ''
    pushLog(
      'success',
      `节点「${label}」执行成功，耗时: ${Math.round(record.durationMs)}ms${suffix}${simulated}`,
    )
  }

  /**
   * 跑一次当前工作副本。
   *
   * 用编辑器里的**未保存副本**而不是存储里已发布的版本：试运行的目的就是「我改完这步
   * 到底对不对」，读已发布版本会让人改完看不到效果。
   *
   * @returns 本次执行记录；没有可执行的图或正在执行时返回 null
   */
  async function run(): Promise<FlowRunRecord | null> {
    const flow = editor.flow.value
    if (!flow || running.value) return null

    running.value = true
    aborted = false
    // 每次运行都从输入表重新开始：上一轮 `state.set` 写下的值不该污染下一轮的分支判定
    scope.value = { ...initialInput.value }
    const startedAt = new Date()
    const startedPerf = performance.now()
    const instanceId = createInstanceId(startedAt)
    const handlers = buildHandlers()

    stepStates.value = {}
    currentNodeId.value = null
    timings.value = []
    settled.value = false

    pushLog('info', `开始执行事件链，实例ID：${instanceId}`)

    /**
     * 呈现侧队列。
     *
     * 执行器全速推进并把每一步按到达顺序塞进来，播放器按节拍消费。并发是有意的：
     * 串行「跑一步等一步」会把节拍算进 `durationMs`，性能监控就不再是真实耗时了。
     */
    const queue: Array<{ timing: FlowNodeTiming; record: ActionStepRecord }> = []
    let executing = true

    // 用箭头常量而不是函数声明：函数声明会被当成可能在 `flow` 收窄之前调用，
    // 闭包里读到的 `editor.flow.value` 就退回 `FlowDefinition | undefined`
    const commit = (step: { timing: FlowNodeTiming; record: ActionStepRecord }): void => {
      timings.value = [...timings.value, step.timing]
      stepStates.value = { ...stepStates.value, [step.timing.nodeId]: step.timing.outcome }
      describeStep(flow, step.record)
    }

    async function playQueue(): Promise<void> {
      while (executing || queue.length > 0) {
        const step = queue.shift()
        if (!step) {
          // 队列暂时空着但执行还没结束（例如一个 flow.delay 正在等）：小睡后再看
          await delay(PLAYBACK_IDLE_MS)
          continue
        }

        if (!stepAnimation.value) {
          commit(step)
          continue
        }

        currentNodeId.value = step.timing.nodeId
        const runningMs = Math.round(STEP_BEAT_MS * STEP_RUNNING_SHARE)
        await delay(runningMs)
        commit(step)
        currentNodeId.value = null
        await delay(STEP_BEAT_MS - runningMs)
      }

      currentNodeId.value = null
    }

    const playback = playQueue()

    const result = await runFlowGraph(flow, {
      handlerOf: (type) => handlers.get(type),
      createScope,
      evaluateCondition: (expr, evalScope) => expression.compile(expr.raw).evaluate(evalScope),
      resolveValue: (value, evalScope) => expression.resolveValue(value, evalScope),
      onStep: (record) => {
        queue.push({
          record,
          timing: {
            nodeId: record.actionId,
            label: nodeLabel(flow, record),
            durationMs: Math.round(record.durationMs),
            outcome: record.outcome,
          },
        })
      },
      isDisposed: () => aborted,
    })

    const endedAt = new Date()
    // 耗时在执行结束的一刻就定下来，不把动画时间算进真实耗时
    const durationMs = Math.round(performance.now() - startedPerf)
    executing = false
    // 概要与结束日志要等播放器收尾，否则「流程执行成功」会排在最后几步的日志前面
    await playback
    // 落定之后才允许给没走到的节点与分支上色，画布按这个标志决定是否补未到达态
    settled.value = true

    const record: FlowRunRecord = {
      instanceId,
      status: result.status,
      steps: result.steps,
      durationMs,
      startedAt: formatClock(startedAt),
      endedAt: formatClock(endedAt),
      message: result.status === 'failed' ? result.message : undefined,
    }

    summary.value = record
    records.value = [record, ...records.value].slice(0, 20)
    pushLog(
      // 走到 flow.end 与走完全部节点都是成功；只有失败与被中止才需要另两种颜色
      record.status === 'failed'
        ? 'error'
        : record.status === 'aborted'
          ? 'warning'
          : 'success',
      `流程${statusLabel(record.status)}，共 ${record.steps} 步，耗时 ${record.durationMs}ms${
        record.message ? `：${record.message}` : ''
      }`,
    )
    running.value = false

    return record
  }

  function stop(): void {
    if (!running.value) return

    aborted = true
    pushLog('warning', '已请求中止，当前步骤完成后停止')
  }

  const totalDuration = computed(() =>
    timings.value.reduce((sum, item) => sum + item.durationMs, 0),
  )

  const slowestNode = computed(() =>
    timings.value.reduce<FlowNodeTiming | null>(
      (slowest, item) => (!slowest || item.durationMs > slowest.durationMs ? item : slowest),
      null,
    ),
  )

  return {
    logs,
    records,
    timings,
    stepStates,
    currentNodeId,
    settled,
    stepAnimation,
    summary,
    running,
    scope,
    initialInput,
    setInitialInput,
    run,
    stop,
    totalDuration,
    slowestNode,
  }
}

/**
 * 结果判别的中文标签，供面板与日志复用。
 *
 * `stopped` 不算失败：`flow.end` 是作者显式写下的终止节点，走到它正是预期结果，
 * 所以文案里同时给出「成功」和「在哪里停的」，而不是用一个警告色暗示出了问题。
 */
export function statusLabel(status: ActionRunResult['status']): string {
  if (status === 'completed') return '执行成功'
  if (status === 'stopped') return '执行成功（提前结束）'
  if (status === 'failed') return '执行失败'

  return '已中止'
}
