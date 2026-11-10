import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import type {
  BranchMeta,
  Commit,
  DiffResult,
  MergePlan,
  MergeResolution,
  ObjectHash,
  VersionHead,
  VersionHostService,
  VersionPanelSection,
  VersionReleaseSummary,
  VersionService,
} from '@lc/contracts'
import type { ValidationIssue } from '@lc/schema'
import { useAppContext } from '@lc/vue'
import {
  buildResolutions,
  commitAvailability,
  diffCount,
  groupConflicts,
  groupDiff,
  historyRows,
  mergeAvailability,
  shortHash,
  withReviewDefaults,
} from './model'

/**
 * 版本面板的数据层。
 *
 * 只做三件事：把 Context 里的 `version` 服务桥接成 Vue 响应式状态、把用户动作翻译成
 * `VersionService` 调用、管理异步竞态与资源释放。所有分组 / 裁决规则在 `model.ts`，
 * 所有渲染在 `VersionPanel.vue`。
 *
 * 边界：宿主声明 `workingTreeReplaceable: false`，`writeWorkingTree` 只把检出树交给只读
 * 版本视图，不回写五类资产。因此这里的「检出」是查看历史，不是把工作区切过去：查看其它
 * 分支期间内核会拒绝提交与合并，避免把当前草稿记到别的分支上。UI 必须如实标注，见
 * `checkoutHint`。
 */

const DEFAULT_LOG_LIMIT = 50

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * 创建版本面板的响应式状态。
 *
 * 从应用上下文取版本宿主服务；服务缺失是「宿主未接入」的合法状态，此时降级为空态而非抛错。
 */
export function useVersionPanel(props: { context?: Record<string, unknown> }) {
  const ctx = useAppContext()
  // bootstrap 在挂载任何视图之前就装好版本宿主服务，因此这里取一次即可；
  // 服务缺失是「宿主未接入」的合法状态，用空态解释而不是抛错。
  const host = ctx.get<VersionHostService>('version')

  const projectId = computed(() => {
    const value = props.context?.projectId
    return typeof value === 'string' ? value : ''
  })

  const activeSection = ref<VersionPanelSection>('history')
  const busy = ref(false)
  const error = ref('')
  const notice = ref('')
  const revision = ref(0)

  const service = shallowRef<VersionService>()
  const commits = ref<Commit[]>([])
  const branches = ref<BranchMeta[]>([])
  const head = ref<VersionHead>()
  const releases = ref<readonly VersionReleaseSummary[]>([])
  const releaseIssues = ref<readonly ValidationIssue[]>([])
  const diff = shallowRef<DiffResult>()
  const mergePlan = shallowRef<MergePlan>()

  const selectedCommitId = ref<ObjectHash>('')
  const showAllParents = ref(false)
  const commitMessage = ref('')
  const newBranchName = ref('')
  const mergeTarget = ref('')
  const choices = ref<Record<string, MergeResolution['choice']>>({})
  const manualTexts = ref<Record<string, string>>({})

  let generation = 0
  const disposables: Array<{ dispose(): void }> = []

  const available = computed(() => host !== undefined)
  const enabled = computed(
    () => host !== undefined && host.mode !== 'off' && projectId.value !== '',
  )
  const mode = computed(() => host?.mode ?? 'off')
  const history = computed(() => historyRows(commits.value))
  const conflictGroups = computed(() => groupConflicts(mergePlan.value?.conflicts ?? []))
  const diffGroups = computed(() => (diff.value ? groupDiff(diff.value) : []))
  const diffTotal = computed(() => (diff.value ? diffCount(diff.value) : 0))
  const selectedCommit = computed(() =>
    commits.value.find((item) => item.id === selectedCommitId.value),
  )
  const diffBase = computed(() => selectedCommit.value?.parents[0] ?? '')
  const checkoutHint =
    '检出只切换版本视图的读取目标，不会覆盖当前草稿资产；查看其它分支期间提交会被拒绝，' +
    '检出回工作分支后恢复。'

  // 按钮可用性由内核给出的 head 状态推导（规则在 model.ts，可单测），
  // 不让用户点了才吃 read-only-view。受保护分支不在此列：内核仍会拒绝，
  // 但当前没有任何入口能把分支设为 protected，提前置灰会是永远不触发的死 UI。
  const commitAccess = computed(() => commitAvailability(head.value))
  const mergeAccess = computed(() => mergeAvailability(head.value))

  function reset(): void {
    service.value = undefined
    commits.value = []
    branches.value = []
    head.value = undefined
    diff.value = undefined
    mergePlan.value = undefined
    releases.value = []
    releaseIssues.value = []
    selectedCommitId.value = ''
  }

  async function loadDiff(next: VersionService, token: number): Promise<void> {
    const target = selectedCommitId.value
    const base = commits.value.find((item) => item.id === target)?.parents[0]
    if (!target || !base) {
      diff.value = undefined
      return
    }

    const result = await next.diff(base, target)
    if (token === generation) diff.value = result
  }

  async function refresh(): Promise<void> {
    const token = ++generation
    if (!host || !enabled.value) {
      reset()
      return
    }

    try {
      const session = await host.session(projectId.value)
      if (!session || token !== generation) return
      service.value = session

      const [log, branchList] = await Promise.all([
        session.log({ limit: DEFAULT_LOG_LIMIT, firstParent: !showAllParents.value }),
        session.listBranches(),
      ])
      if (token !== generation) return

      commits.value = [...log]
      branches.value = [...branchList]
      head.value = { ...session.head }

      // `checkRelease` 是「collectProjectAssets + 四道发布闸门」的全项目同步计算，
      // 而它只在发布区渲染。跟着每次版本事件跑，等于保存一次页面就把整个项目校验一遍；
      // 改为进入发布区时按需读，切进来那一次由 setSection 补。
      if (activeSection.value === 'releases') {
        releases.value = host.releases(projectId.value)
        releaseIssues.value = [...host.checkRelease(projectId.value)]
      }

      if (selectedCommitId.value && !log.some((item) => item.id === selectedCommitId.value)) {
        selectedCommitId.value = ''
      }
      await loadDiff(session, token)
    } catch (cause) {
      if (token === generation) error.value = messageOf(cause)
    }
  }

  /** 写操作统一入口：防重入、清空上一轮反馈、把异常收敛成面板内可读文案。 */
  async function run(task: () => Promise<void>): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = ''
    notice.value = ''
    try {
      await task()
    } catch (cause) {
      error.value = messageOf(cause)
    } finally {
      busy.value = false
    }
  }

  function requireService(): VersionService {
    const current = service.value
    if (!current) throw new Error('版本库会话尚未就绪，请稍后重试')
    return current
  }

  function selectCommit(id: ObjectHash): void {
    selectedCommitId.value = id
    activeSection.value = 'diff'
    void refresh()
  }

  function setSection(section: VersionPanelSection): void {
    activeSection.value = section
    // 发布区的快照与闸门结果是按需读的，切进来必须补一次，否则显示的是上一次的旧值
    if (section === 'releases') void refresh()
  }

  function commit(): void {
    void run(async () => {
      const created = await requireService().commit({
        message: commitMessage.value.trim() || '版本面板提交',
      })
      commitMessage.value = ''
      notice.value = created ? `已提交 ${shortHash(created.id)}` : '内容未变化，未产生新提交'
      await refresh()
    })
  }

  function createBranch(): void {
    void run(async () => {
      const name = newBranchName.value.trim()
      if (name === '') throw new Error('分支名不能为空')
      const created = await requireService().createBranch(name, head.value?.commit ?? '')
      newBranchName.value = ''
      notice.value = `已创建分支 ${created.name}`
      await refresh()
    })
  }

  function checkout(name: string): void {
    void run(async () => {
      // force 在这条链上是安全的：宿主声明了 workingTreeReplaceable: false，内核把检出
      // 当只读查看处理——不回写草稿、不持久化 HEAD，并在查看态下拒绝提交，因此草稿不会
      // 被覆盖，也不会被记到刚检出的分支上。
      const next = await requireService().checkout(name, { force: true })
      head.value = { ...next }
      notice.value = `已检出 ${name}。${checkoutHint}`
      await refresh()
    })
  }

  function previewMerge(target: string): Promise<void> {
    return run(async () => {
      const value = target.trim()
      if (value === '') throw new Error('请填写要合入的分支名或提交地址')
      mergeTarget.value = value

      const plan = await requireService().mergePreview(value)
      mergePlan.value = plan
      // review 档预填缺省裁决，blocking 档留给用户逐条决定
      choices.value = withReviewDefaults(plan.conflicts, {})
      manualTexts.value = {}

      if (plan.conflicts.length > 0) {
        activeSection.value = 'conflicts'
        const groups = groupConflicts(plan.conflicts)
        notice.value =
          `预览完成：${groups.blocking.length} 处必须裁决，` +
          `${groups.review.length} 处已按「采用本侧」预填，可抽查后调整`
      } else {
        notice.value = '预览完成：无冲突，可执行合并'
      }
    })
  }

  function applyMerge(): void {
    void run(async () => {
      const plan = mergePlan.value
      if (!plan) throw new Error('请先执行一次合并预览')

      const built = buildResolutions(plan.conflicts, {
        choices: choices.value,
        manual: manualTexts.value,
      })
      if (!built.ok) throw new Error(built.message)

      const result = await requireService().merge(mergeTarget.value, {
        resolutions: built.resolutions,
      })
      mergePlan.value = result.plan

      if (
        result.status === 'merged' ||
        result.status === 'fast-forward' ||
        result.status === 'up-to-date'
      ) {
        mergePlan.value = undefined
        choices.value = {}
        manualTexts.value = {}
        notice.value =
          result.status === 'merged' && result.commit
            ? `已合并，提交 ${shortHash(result.commit.id)}`
            : result.status === 'fast-forward'
              ? '已快进到目标提交'
              : '目标已是当前祖先，无需合并'
      } else {
        // 裁决后重算的 plan 可能带出新的 review 冲突；已有的选择不覆盖
        choices.value = withReviewDefaults(result.plan.conflicts, choices.value)
        error.value =
          result.status === 'invalid'
            ? '合并产物未通过结构校验，请检查问题清单'
            : '仍有冲突未裁决'
      }
      await refresh()
    })
  }

  function choose(conflictId: string, choice: MergeResolution['choice']): void {
    choices.value = { ...choices.value, [conflictId]: choice }
  }

  function setManual(conflictId: string, text: string): void {
    manualTexts.value = { ...manualTexts.value, [conflictId]: text }
    choices.value = { ...choices.value, [conflictId]: 'manual' }
  }

  function publish(): void {
    void run(async () => {
      if (!host) throw new Error('宿主未提供版本服务')
      const created = host.publish(projectId.value)
      notice.value = `已发布 v${created}`
      await refresh()
    })
  }

  function rollback(target: number): void {
    void run(async () => {
      if (!host) throw new Error('宿主未提供版本服务')
      host.rollback(projectId.value, target)
      notice.value = `线上版本已切到 v${target}，草稿未改动`
      await refresh()
    })
  }

  if (host) {
    disposables.push(
      host.onDidChange(() => {
        revision.value += 1
      }),
    )
  }
  disposables.push(
    ctx.on('version:open', (payload) => {
      // 走 setSection 而不是直接赋值：命令打开发布区时同样需要按需补读闸门结果
      setSection(payload.section)
      if (payload.previewTarget !== undefined) void previewMerge(payload.previewTarget)
    }),
  )

  watch([projectId, revision, showAllParents], () => void refresh(), { immediate: true })

  onUnmounted(() => {
    generation += 1
    for (const disposable of disposables.splice(0)) disposable.dispose()
  })

  return {
    activeSection,
    available,
    branches,
    busy,
    checkoutHint,
    choices,
    commitAccess,
    commitMessage,
    commits,
    conflictGroups,
    diff,
    diffBase,
    diffGroups,
    diffTotal,
    enabled,
    error,
    head,
    history,
    manualTexts,
    mergeAccess,
    mergePlan,
    mergeTarget,
    mode,
    newBranchName,
    notice,
    releaseIssues,
    releases,
    selectedCommit,
    selectedCommitId,
    showAllParents,

    applyMerge,
    checkout,
    choose,
    commit,
    createBranch,
    previewMerge,
    publish,
    refresh,
    rollback,
    selectCommit,
    setManual,
    setSection,
  }
}
