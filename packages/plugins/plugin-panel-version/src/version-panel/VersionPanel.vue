<script setup lang="ts">
import { computed } from 'vue'
import type { VersionPanelSection } from '@lc/contracts'
import { useVersionPanel } from './use-version-panel'
import { conflictLocation, formatTime, formatValue, shortHash as short } from './model'

/**
 * 版本面板：历史 / 差异 / 分支 / 冲突 / 发布五区。
 *
 * 组件只做渲染与事件转发，数据来自 `useVersionPanel`，分组与裁决规则来自 `model.ts`。
 * 冲突区刻意按严重度分成两块：两侧改同一字段与先接受默认值再抽查顺序问题，
 * 不该以同样的视觉权重摆在一份列表里。
 */

const props = defineProps<{
  /** 宿主 LcSlot 下发的只读上下文；版本会话按其中的 projectId 分库 */
  context?: Record<string, unknown>
}>()

const {
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
} = useVersionPanel(props)

const tabs: ReadonlyArray<{ id: VersionPanelSection; label: string }> = [
  { id: 'history', label: '历史' },
  { id: 'diff', label: '差异' },
  { id: 'branches', label: '分支' },
  { id: 'conflicts', label: '冲突' },
  { id: 'releases', label: '发布' },
]

const OPTION_LABELS: Readonly<Record<string, string>> = {
  ours: '采用本侧',
  theirs: '采用对侧',
  base: '回到基线',
  manual: '编辑 JSON',
}

const CHANGE_LABELS: Readonly<Record<string, string>> = {
  added: '新增',
  removed: '删除',
  modified: '修改',
}

const blockingCount = computed(
  () => releaseIssues.value.filter((issue) => issue.severity === 'error').length,
)

function optionLabel(option: string): string {
  return OPTION_LABELS[option] ?? option
}

function changeLabel(change: string): string {
  return CHANGE_LABELS[change] ?? change
}

function onManualInput(conflictId: string, event: Event): void {
  const target = event.target
  if (target instanceof HTMLTextAreaElement) setManual(conflictId, target.value)
}

/** 从分支列表直接发起预览；写回输入框让目标在切换分区后仍然可见。 */
function previewBranch(name: string): void {
  mergeTarget.value = name
  void previewMerge(name)
}
</script>

<template>
  <div class="lc-version">
    <div v-if="!available" class="lc-version__placeholder" role="status">
      宿主尚未接入版本服务，本面板无可用数据。
    </div>

    <template v-else>
      <header class="lc-version__head">
        <nav class="lc-version__tabs" role="tablist" aria-label="版本面板分区">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            type="button"
            role="tab"
            class="lc-version__tab"
            :class="{ 'lc-version__tab--active': activeSection === tab.id }"
            :aria-selected="activeSection === tab.id"
            @click="setSection(tab.id)"
          >
            {{ tab.label }}
          </button>
        </nav>

        <div class="lc-version__status">
          <span class="lc-version__chip">档位 {{ mode }}</span>
          <span v-if="head" class="lc-version__chip">分支 {{ head.branch ?? '游离' }}</span>
          <span v-if="head" class="lc-version__mono">HEAD {{ short(head.commit) }}</span>
          <span v-if="head?.hasUncommitted" class="lc-version__chip lc-version__chip--warn">
            有未提交内容
          </span>
        </div>
      </header>

      <p v-if="error" class="lc-version__alert" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="lc-version__notice" role="status">{{ notice }}</p>
      <p v-if="busy" class="lc-version__hint">处理中…</p>

      <div class="lc-version__body">
        <!-- 历史区 -->
        <section v-if="activeSection === 'history'" aria-label="历史">
          <p v-if="!enabled" class="lc-version__placeholder">
            版本控制当前为 off 档位。设置 VITE_LC_VERSION_MODE=shadow 或 on 后重新构建，
            即可开始记录历史；发布与回滚仍可在「发布」区使用。
          </p>

          <template v-else>
            <div class="lc-version__toolbar">
              <input
                v-model="commitMessage"
                class="lc-version__input"
                type="text"
                placeholder="提交说明（留空则使用默认文案）"
                aria-label="提交说明"
              />
              <button
                type="button"
                class="lc-version__button"
                :disabled="busy || !commitAccess.allowed"
                @click="commit"
              >
                提交
              </button>
              <span v-if="commitAccess.reason" class="lc-version__hint">
                {{ commitAccess.reason }}
              </span>
              <label class="lc-version__check">
                <input v-model="showAllParents" type="checkbox" />
                展开合并双亲
              </label>
              <button
                type="button"
                class="lc-version__button"
                :disabled="busy"
                @click="refresh"
              >
                刷新
              </button>
            </div>

            <ul v-if="history.length" class="lc-version__list">
              <li v-for="row in history" :key="row.id">
                <button
                  type="button"
                  class="lc-version__row"
                  :class="{ 'lc-version__row--active': selectedCommitId === row.id }"
                  @click="selectCommit(row.id)"
                >
                  <span class="lc-version__mono">{{ row.shortId }}</span>
                  <span class="lc-version__row-main">{{ row.message }}</span>
                  <span v-if="row.isMerge" class="lc-version__tag"
                    >合并 · {{ row.parents.length }} 父</span
                  >
                  <span v-if="row.publishLabel" class="lc-version__tag">{{
                    row.publishLabel
                  }}</span>
                  <span class="lc-version__meta">{{ row.author }} · {{ row.createdAt }}</span>
                </button>
              </li>
            </ul>
            <p v-else class="lc-version__placeholder">
              还没有提交。保存一次页面或发布一次项目即可生成第一条历史。
            </p>
          </template>
        </section>

        <!-- 差异区 -->
        <section v-else-if="activeSection === 'diff'" aria-label="差异">
          <p v-if="!enabled" class="lc-version__placeholder">
            版本控制当前为 off 档位，暂无差异数据。
          </p>
          <p v-else-if="!selectedCommit" class="lc-version__placeholder">
            在「历史」选一条提交，查看它与第一父提交的差异。
          </p>
          <p v-else-if="!diffBase" class="lc-version__placeholder">
            {{ short(selectedCommit.id) }} 是根提交，没有可比较的基线。
          </p>

          <template v-else>
            <p class="lc-version__hint">
              {{ short(diffBase) }} → {{ short(selectedCommit?.id ?? '') }} ·
              {{ diffTotal }} 处变更
            </p>

            <div v-for="group in diffGroups" :key="group.docId" class="lc-version__group">
              <h4 class="lc-version__group-title">
                {{ group.docId }}
                <span v-if="group.added" class="lc-version__tag">新增文档</span>
                <span v-if="group.removed" class="lc-version__tag">删除文档</span>
              </h4>

              <div
                v-for="section in group.sections"
                :key="section.section"
                class="lc-version__section"
              >
                <h5 class="lc-version__section-title">{{ section.section }}</h5>
                <table class="lc-version__table">
                  <thead>
                    <tr>
                      <th>实体</th>
                      <th>变更</th>
                      <th>基线</th>
                      <th>当前</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(change, index) in section.changes"
                      :key="`${change.entityId}-${index}`"
                    >
                      <td class="lc-version__mono">{{ change.entityId }}</td>
                      <td>{{ changeLabel(change.change) }}</td>
                      <td>
                        <pre class="lc-version__value">{{ formatValue(change.base) }}</pre>
                      </td>
                      <td>
                        <pre class="lc-version__value">{{ formatValue(change.ours) }}</pre>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <p v-if="!diffTotal" class="lc-version__placeholder">这一版没有变更。</p>
          </template>
        </section>

        <!-- 分支区 -->
        <section v-else-if="activeSection === 'branches'" aria-label="分支">
          <p v-if="!enabled" class="lc-version__placeholder">
            版本控制当前为 off 档位，暂无分支数据。
          </p>

          <template v-else>
            <div class="lc-version__toolbar">
              <input
                v-model="newBranchName"
                class="lc-version__input"
                type="text"
                placeholder="新分支名"
                aria-label="新分支名"
              />
              <button
                type="button"
                class="lc-version__button"
                :disabled="busy"
                @click="createBranch"
              >
                新建分支
              </button>
              <input
                v-model="mergeTarget"
                class="lc-version__input"
                type="text"
                placeholder="合入目标（分支 / 提交）"
                aria-label="合入目标"
              />
              <button
                type="button"
                class="lc-version__button"
                :disabled="busy"
                @click="previewMerge(mergeTarget)"
              >
                预览合并
              </button>
            </div>

            <ul class="lc-version__list">
              <li v-for="branch in branches" :key="branch.name" class="lc-version__branch">
                <span class="lc-version__branch-name">{{ branch.name }}</span>
                <span v-if="branch.protected" class="lc-version__tag">受保护</span>
                <span class="lc-version__mono">{{ short(branch.base) }}</span>
                <button
                  type="button"
                  class="lc-version__button"
                  :disabled="busy || head?.branch === branch.name"
                  @click="checkout(branch.name)"
                >
                  检出
                </button>
                <button
                  type="button"
                  class="lc-version__button"
                  :disabled="busy"
                  @click="previewBranch(branch.name)"
                >
                  合入
                </button>
              </li>
            </ul>

            <p class="lc-version__hint">{{ checkoutHint }}</p>
            <p v-if="mergeAccess.reason" class="lc-version__hint">{{ mergeAccess.reason }}</p>

            <div v-if="mergePlan" class="lc-version__plan">
              <p>
                预览状态 {{ mergePlan?.status }} · 结构校验 {{ mergePlan?.validation }} ·
                {{ mergePlan?.conflicts.length ?? 0 }} 处冲突 ·
                {{ mergePlan?.danglingRefs.length ?? 0 }} 处悬空引用
              </p>
              <button
                v-if="!(mergePlan?.conflicts.length ?? 0)"
                type="button"
                class="lc-version__button"
                :disabled="busy || !mergeAccess.allowed || mergePlan?.status === 'invalid'"
                @click="applyMerge"
              >
                执行合并
              </button>
            </div>
          </template>
        </section>

        <!-- 冲突区 -->
        <section v-else-if="activeSection === 'conflicts'" aria-label="冲突">
          <p v-if="!enabled" class="lc-version__placeholder">
            版本控制当前为 off 档位，暂无合并冲突。
          </p>
          <p v-else-if="!mergePlan" class="lc-version__placeholder">
            先在「分支」区选择合入目标并执行一次预览；冲突会在这里逐条列出。
          </p>

          <template v-else>
            <p class="lc-version__hint">
              {{ mergePlan?.message }} · 校验 {{ mergePlan?.validation }} · 基线
              {{ (mergePlan?.bases ?? []).map(short).join('、') || '—' }}
            </p>

            <div v-if="(mergePlan?.issues.length ?? 0) > 0" class="lc-version__issues">
              <h4 class="lc-version__group-title">结构校验问题</h4>
              <p
                v-for="(issue, index) in mergePlan?.issues ?? []"
                :key="index"
                :class="{ 'lc-version__issue--error': issue.severity === 'error' }"
              >
                {{ issue.severity }} · {{ issue.path }} · {{ issue.message }}
              </p>
            </div>

            <div v-if="(mergePlan?.danglingRefs.length ?? 0) > 0" class="lc-version__issues">
              <h4 class="lc-version__group-title">悬空引用（需抽查）</h4>
              <p v-for="(item, index) in mergePlan?.danglingRefs ?? []" :key="index">
                {{ item.location.docId }} / {{ item.location.section }} / {{ item.field }} →
                {{ item.refId }}
              </p>
            </div>

            <h4 class="lc-version__group-title">
              必须裁决（{{ conflictGroups.blocking.length }}）
            </h4>
            <p v-if="!conflictGroups.blocking.length" class="lc-version__hint">无。</p>

            <article
              v-for="conflict in conflictGroups.blocking"
              :key="conflict.id"
              class="lc-version__conflict"
            >
              <header class="lc-version__conflict-head">
                <span class="lc-version__tag lc-version__tag--danger">{{ conflict.kind }}</span>
                <span class="lc-version__mono">{{ conflictLocation(conflict) }}</span>
              </header>
              <p class="lc-version__hint">{{ conflict.message }}</p>
              <div class="lc-version__triple">
                <div>
                  <h6>基线</h6>
                  <pre class="lc-version__value">{{ formatValue(conflict.base) }}</pre>
                </div>
                <div>
                  <h6>本侧</h6>
                  <pre class="lc-version__value">{{ formatValue(conflict.ours) }}</pre>
                </div>
                <div>
                  <h6>对侧</h6>
                  <pre class="lc-version__value">{{ formatValue(conflict.theirs) }}</pre>
                </div>
              </div>
              <div class="lc-version__options">
                <button
                  v-for="option in conflict.options"
                  :key="option"
                  type="button"
                  class="lc-version__button"
                  :class="{ 'lc-version__button--active': choices[conflict.id] === option }"
                  :disabled="busy"
                  @click="choose(conflict.id, option)"
                >
                  {{ optionLabel(option) }}
                </button>
              </div>
              <textarea
                v-if="conflict.options.includes('manual') && choices[conflict.id] === 'manual'"
                class="lc-version__input lc-version__textarea"
                rows="4"
                :value="manualTexts[conflict.id] ?? ''"
                :aria-label="`冲突 ${conflictLocation(conflict)} 的手工裁决值`"
                @input="onManualInput(conflict.id, $event)"
              />
            </article>

            <h4 class="lc-version__group-title">
              建议抽查（{{ conflictGroups.review.length }}）· 已按「采用本侧」预填
            </h4>
            <p v-if="!conflictGroups.review.length" class="lc-version__hint">无。</p>
            <article
              v-for="conflict in conflictGroups.review"
              :key="conflict.id"
              class="lc-version__conflict"
            >
              <header class="lc-version__conflict-head">
                <span class="lc-version__tag">{{ conflict.kind }}</span>
                <span class="lc-version__mono">{{ conflictLocation(conflict) }}</span>
              </header>
              <p class="lc-version__hint">{{ conflict.message }}</p>
              <div class="lc-version__options">
                <button
                  v-for="option in conflict.options"
                  :key="option"
                  type="button"
                  class="lc-version__button"
                  :class="{ 'lc-version__button--active': choices[conflict.id] === option }"
                  :disabled="busy"
                  @click="choose(conflict.id, option)"
                >
                  {{ optionLabel(option) }}
                </button>
              </div>
            </article>

            <div class="lc-version__toolbar">
              <button
                type="button"
                class="lc-version__button lc-version__button--primary"
                :disabled="busy || !mergeAccess.allowed || mergePlan?.status === 'invalid'"
                @click="applyMerge"
              >
                应用裁决并合并
              </button>
              <span v-if="mergeAccess.reason" class="lc-version__hint">
                {{ mergeAccess.reason }}
              </span>
              <span v-else class="lc-version__hint">
                「必须裁决」要逐条选；「建议抽查」已预填采用本侧，改动过就照实改。
                未裁决完或校验不通过时内核不会写入任何对象。
              </span>
            </div>
          </template>
        </section>

        <!-- 发布区 -->
        <section v-else aria-label="发布">
          <div class="lc-version__toolbar">
            <button
              type="button"
              class="lc-version__button lc-version__button--primary"
              :disabled="busy || blockingCount > 0"
              @click="publish"
            >
              发布当前内容
            </button>
            <span v-if="blockingCount > 0" class="lc-version__alert">
              存在 {{ blockingCount }} 条阻断问题，发布会被拒绝。
            </span>
            <span class="lc-version__hint">回滚只移动线上指针，不改动草稿资产。</span>
          </div>

          <div v-if="releaseIssues.length" class="lc-version__issues">
            <h4 class="lc-version__group-title">发布闸门结果</h4>
            <p
              v-for="(issue, index) in releaseIssues"
              :key="index"
              :class="{ 'lc-version__issue--error': issue.severity === 'error' }"
            >
              {{ issue.severity }} · {{ issue.path }} · {{ issue.message }}
            </p>
          </div>

          <h4 class="lc-version__group-title">发布快照</h4>
          <ul v-if="releases.length" class="lc-version__list">
            <li v-for="release in releases" :key="release.revision" class="lc-version__branch">
              <span>v{{ release.revision }}</span>
              <span class="lc-version__meta">{{ formatTime(release.createdAt) }}</span>
              <span v-if="release.current" class="lc-version__tag">当前线上</span>
              <button
                type="button"
                class="lc-version__button"
                :disabled="busy || release.current"
                @click="rollback(release.revision)"
              >
                切回此版本
              </button>
            </li>
          </ul>
          <p v-else class="lc-version__placeholder">还没有发布快照。</p>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lc-version {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-height: 0;
  padding: 10px 12px;
  color: var(--lc-text);
  font-size: 12px;
}

.lc-version__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-version__tabs {
  display: flex;
  gap: 4px;
}

.lc-version__tab {
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: var(--lc-radius-sm);
  background: transparent;
  color: var(--lc-text-secondary);
  cursor: pointer;
}

.lc-version__tab:hover,
.lc-version__tab:focus-visible {
  color: var(--lc-text);
  background: var(--lc-accent-soft);
}

.lc-version__tab--active {
  border-color: var(--lc-border-strong);
  color: var(--lc-text);
  background: var(--lc-accent-soft);
}

.lc-version__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--lc-text-secondary);
}

.lc-version__chip {
  padding: 2px 6px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
}

.lc-version__chip--warn {
  border-color: var(--lc-danger-border);
  color: var(--lc-danger);
}

.lc-version__body {
  min-height: 0;
  padding-top: 8px;
  overflow: auto;
}

.lc-version__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.lc-version__input {
  box-sizing: border-box;
  min-width: 140px;
  padding: 4px 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font: inherit;
}

.lc-version__input:focus-visible {
  outline: 2px solid var(--lc-accent);
  outline-offset: 1px;
}

.lc-version__textarea {
  width: 100%;
  margin-top: 6px;
  font-family: var(--lc-font-mono, monospace);
  resize: vertical;
}

.lc-version__button {
  padding: 4px 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  cursor: pointer;
}

.lc-version__button:hover:not(:disabled),
.lc-version__button:focus-visible {
  border-color: var(--lc-border-strong);
  background: var(--lc-accent-soft);
}

.lc-version__button--active,
.lc-version__button--primary {
  border-color: var(--lc-border-strong);
  background: var(--lc-accent-soft);
}

.lc-version__button:disabled {
  color: var(--lc-text-muted);
  cursor: not-allowed;
}

.lc-version__check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--lc-text-secondary);
  cursor: pointer;
}

.lc-version__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.lc-version__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: var(--lc-radius-sm);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.lc-version__row:hover,
.lc-version__row--active {
  border-color: var(--lc-border);
  background: var(--lc-surface-sunken);
}

.lc-version__row-main {
  flex: 1 1 180px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-version__branch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--lc-border);
}

.lc-version__branch-name {
  font-weight: 600;
}

.lc-version__mono {
  color: var(--lc-text-muted);
  font-family: var(--lc-font-mono, monospace);
  font-size: 11px;
}

.lc-version__meta,
.lc-version__hint {
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-version__tag {
  padding: 1px 6px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-version__tag--danger {
  border-color: var(--lc-danger-border);
  color: var(--lc-danger);
}

.lc-version__placeholder {
  padding: 12px;
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-secondary);
  text-align: center;
}

.lc-version__alert {
  margin: 6px 0;
  padding: 6px 8px;
  border: 1px solid var(--lc-danger-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-danger-surface);
  color: var(--lc-danger);
}

.lc-version__notice {
  margin: 6px 0;
  padding: 6px 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  color: var(--lc-success);
}

.lc-version__group {
  margin-bottom: 10px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  overflow: hidden;
}

.lc-version__group-title {
  margin: 0;
  padding: 6px 8px;
  background: var(--lc-surface-sunken);
  font-size: 12px;
  font-weight: 600;
}

.lc-version__section-title {
  margin: 0;
  padding: 4px 8px;
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-version__table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.lc-version__table th,
.lc-version__table td {
  padding: 4px 8px;
  border-top: 1px solid var(--lc-border);
  text-align: left;
  vertical-align: top;
}

.lc-version__table th {
  color: var(--lc-text-secondary);
  font-weight: 500;
}

.lc-version__triple {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.lc-version__triple h6 {
  margin: 0 0 4px;
  color: var(--lc-text-secondary);
  font-size: 11px;
  font-weight: 500;
}

.lc-version__value {
  max-height: 120px;
  margin: 0;
  padding: 4px 6px;
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: var(--lc-font-mono, monospace);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  overflow: auto;
}

.lc-version__conflict {
  margin-bottom: 8px;
  padding: 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
}

.lc-version__conflict-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.lc-version__options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.lc-version__issues p,
.lc-version__issue--error {
  margin: 4px 0;
  color: var(--lc-text-secondary);
}

.lc-version__issue--error {
  color: var(--lc-danger);
}

.lc-version__plan {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
}

@media (prefers-reduced-motion: reduce) {
  .lc-version__button,
  .lc-version__tab {
    transition: none;
  }
}
</style>
