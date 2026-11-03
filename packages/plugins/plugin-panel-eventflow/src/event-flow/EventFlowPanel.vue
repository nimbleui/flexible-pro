<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { BUILTIN_ACTIONS, PAGE_EVENTS, PAGE_EVENT_SOURCE } from '@lc/schema'
import { useEventFlowPanel } from './composables/use-event-flow-panel'
import { TABS } from './constants/panel-tabs'
import {
  actionCardStyle,
  actionParamSummary,
  actionTitle,
  actionTone,
} from './constants/action-tone'
import { eventIconStyle, eventTone, pageEventLabel } from './constants/event-tone'

defineProps<{
  /** 宿主传入的只读上下文；面板自己从注入的 Context 取服务 */
  context?: Record<string, unknown>
}>()

/** CodeMirror 按需加载：只有展开动作条件时才需要编辑器 */
const ConditionEditor = defineAsyncComponent(() => import('@lc/expression-editor'))

// 模板只需要展示与交互入口，数据来源与写入规则都在 composables 里
const {
  activeTab,
  activeTabLabel,
  actionOptions,
  addAction,
  chainItems,
  commitActionName,
  commitConditionDraft,
  commitEventName,
  commitJson,
  conditionDraft,
  connectionLabel,
  connectionList,
  createConnection,
  createNodeEventFromDraft,
  createSelectedNodeEvent,
  creatorError,
  currentConnection,
  currentConnectionId,
  currentIssues,
  document,
  eventNameDraft,
  expandedSection,
  expressionFunctions,
  expressionSymbols,
  fieldChecked,
  fieldNumber,
  fieldSelectValue,
  fieldText,
  isActionPickerOpen,
  isCreatingEvent,
  isUnlistedSelectValue,
  jsonErrorFor,
  jsonText,
  moveAction,
  onConnectionEnabled,
  onFieldChange,
  onJsonInput,
  removeAction,
  selectAction,
  selectConnection,
  selectedAction,
  selectedActionId,
  selectedActionSummary,
  selectedDefinition,
  selectedNode,
  selectedNodeEvents,
  toggleCurrentConnectionEnabled,
  toggleEventCreator,
  toggleSection,
  triggerSummary,
} = useEventFlowPanel()
</script>

<template>
  <div class="lc-eventflow">
    <nav class="lc-eventflow__tabs" role="tablist" aria-label="底部面板">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        class="lc-eventflow__tab"
        :class="{ 'is-active': activeTab === tab.id }"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        <span class="lc-eventflow__tab-icon" :data-glyph="tab.glyph" aria-hidden="true"></span>
        {{ tab.label }}
      </button>
    </nav>

    <div v-if="!document" class="lc-eventflow__placeholder">文档服务未就绪</div>

    <div v-else-if="activeTab !== 'eventflow'" class="lc-eventflow__placeholder">
      <span>{{ activeTabLabel }} · 尚未接入</span>
      <span class="lc-eventflow__placeholder-hint">该页签将在后续版本提供</span>
    </div>

    <div v-else class="lc-eventflow__body">
      <!-- 左：事件列表 -->
      <aside class="lc-eventflow__events" aria-label="事件列表">
        <div class="lc-eventflow__column-head">
          <span class="lc-eventflow__column-title">页面事件</span>
          <button
            class="lc-eventflow__button"
            type="button"
            :aria-expanded="isCreatingEvent"
            @click="toggleEventCreator"
          >
            + 新建事件
          </button>
        </div>

        <div class="lc-eventflow__events-scroll">
          <div v-if="isCreatingEvent" class="lc-eventflow__creator">
            <span class="lc-eventflow__creator-label">页面事件</span>
            <button
              v-for="eventName in PAGE_EVENTS"
              :key="eventName"
              class="lc-eventflow__creator-option"
              type="button"
              @click="createConnection(PAGE_EVENT_SOURCE, eventName)"
            >
              <span>{{ pageEventLabel(eventName) }}</span>
              <code>{{ eventName }}</code>
            </button>

            <span class="lc-eventflow__creator-label">选中节点</span>
            <template v-if="selectedNode">
              <button
                v-for="definition in selectedNodeEvents"
                :key="definition.name"
                class="lc-eventflow__creator-option"
                type="button"
                @click="createSelectedNodeEvent(definition.name)"
              >
                <span>{{ definition.title || definition.name }}</span>
                <code>{{ definition.name }}</code>
              </button>

              <div class="lc-eventflow__creator-row">
                <input
                  v-model="eventNameDraft"
                  type="text"
                  placeholder="事件名，如 click"
                  @keydown.enter="createNodeEventFromDraft"
                />
                <button
                  class="lc-eventflow__button"
                  type="button"
                  @click="createNodeEventFromDraft"
                >
                  添加
                </button>
              </div>
              <p v-if="selectedNodeEvents.length === 0" class="lc-eventflow__creator-hint">
                物料未声明该组件事件，请手填事件名
              </p>
            </template>
            <p v-else class="lc-eventflow__creator-hint">先在画布中选中一个节点</p>
            <p v-if="creatorError" class="lc-eventflow__creator-error" role="alert">
              {{ creatorError }}
            </p>
          </div>

          <p v-if="connectionList.length === 0" class="lc-eventflow__empty">
            还没有事件，点击「+ 新建事件」开始
          </p>

          <ul v-else class="lc-eventflow__event-list">
            <li
              v-for="connection in connectionList"
              :key="connection.id"
              class="lc-eventflow__event-item"
              :class="{ 'is-active': connection.id === currentConnectionId }"
            >
              <button
                class="lc-eventflow__event-open"
                type="button"
                :title="connectionLabel(connection)"
                @click="selectConnection(connection.id)"
              >
                <span
                  class="lc-eventflow__event-icon"
                  :data-tone="eventTone(connection)"
                  :style="eventIconStyle(connection)"
                  aria-hidden="true"
                ></span>
                <span class="lc-eventflow__event-label">{{ connectionLabel(connection) }}</span>
                <span
                  class="lc-eventflow__event-count"
                  :title="`${connection.actionIds.length} 个动作`"
                >
                  {{ connection.actionIds.length }}
                </span>
              </button>

              <label
                class="lc-eventflow__switch"
                :title="connection.enabled ? '已启用' : '已停用'"
              >
                <input
                  type="checkbox"
                  :checked="connection.enabled"
                  :aria-label="`启用事件 ${connectionLabel(connection)}`"
                  @change="onConnectionEnabled(connection, $event)"
                />
                <span aria-hidden="true"></span>
              </label>
            </li>
          </ul>
        </div>
      </aside>

      <!-- 中：动作链 -->
      <section class="lc-eventflow__chain" aria-label="动作链">
        <div class="lc-eventflow__column-head">
          <span class="lc-eventflow__column-title">动作链</span>
          <span v-if="currentConnection" class="lc-eventflow__chain-hint">
            {{ connectionLabel(currentConnection) }}
            <em v-if="!currentConnection.enabled">已停用</em>
          </span>
        </div>

        <div v-if="!currentConnection" class="lc-eventflow__empty lc-eventflow__empty--block">
          选择左侧事件后编排动作
        </div>

        <template v-else>
          <ul v-if="currentIssues.length > 0" class="lc-eventflow__issues">
            <li
              v-for="(issue, index) in currentIssues"
              :key="`${index}-${issue.path}-${issue.message}`"
              class="lc-eventflow__issue"
              :class="`is-${issue.severity}`"
            >
              <span class="lc-eventflow__issue-level">
                {{ issue.severity === 'error' ? '错误' : '警告' }}
              </span>
              <span class="lc-eventflow__issue-message">{{ issue.message }}</span>
            </li>
          </ul>

          <div class="lc-eventflow__chain-scroll">
            <div class="lc-eventflow__chain-track">
              <template v-for="(item, index) in chainItems" :key="item.id">
                <article
                  class="lc-eventflow__card"
                  :class="{
                    'is-active': item.id === selectedActionId,
                    'is-broken': !item.action,
                  }"
                  :style="actionCardStyle(item.action)"
                  tabindex="0"
                  :aria-label="`${actionTitle(item.action)} ${actionParamSummary(item.action)}`"
                  @click="selectAction(item.id)"
                  @keydown.enter.self.prevent="selectAction(item.id)"
                >
                  <span class="lc-eventflow__card-body">
                    <span
                      class="lc-eventflow__card-icon"
                      :data-glyph="actionTone(item.action)"
                      aria-hidden="true"
                    ></span>
                    <span class="lc-eventflow__card-text">
                      <span class="lc-eventflow__card-title">
                        {{ actionTitle(item.action) }}
                      </span>
                      <span class="lc-eventflow__card-summary">
                        {{ actionParamSummary(item.action) }}
                      </span>
                    </span>
                  </span>

                  <span v-if="!item.action" class="lc-eventflow__card-broken">损坏</span>

                  <div class="lc-eventflow__card-tools" @click.stop>
                    <button
                      class="lc-eventflow__card-tool is-up"
                      type="button"
                      title="上移"
                      aria-label="上移动作"
                      :disabled="index === 0"
                      @click="moveAction(index, -1)"
                    ></button>
                    <button
                      class="lc-eventflow__card-tool is-down"
                      type="button"
                      title="下移"
                      aria-label="下移动作"
                      :disabled="index === chainItems.length - 1"
                      @click="moveAction(index, 1)"
                    ></button>
                    <button
                      class="lc-eventflow__card-tool is-remove"
                      type="button"
                      :title="item.action ? '删除动作' : '移除悬空引用'"
                      :aria-label="item.action ? '删除动作' : '移除悬空引用'"
                      @click="removeAction(item.id)"
                    ></button>
                  </div>
                </article>

                <span class="lc-eventflow__arrow" aria-hidden="true">→</span>
              </template>

              <button
                class="lc-eventflow__add-card"
                type="button"
                :aria-expanded="isActionPickerOpen"
                @click="isActionPickerOpen = !isActionPickerOpen"
              >
                + 添加动作
              </button>
            </div>
          </div>

          <div v-if="isActionPickerOpen" class="lc-eventflow__action-picker">
            <button
              v-for="definition in BUILTIN_ACTIONS"
              :key="definition.type"
              class="lc-eventflow__action-option"
              type="button"
              @click="addAction(definition.type)"
            >
              <span class="lc-eventflow__action-option-title">{{ definition.title }}</span>
              <span class="lc-eventflow__action-option-desc">{{ definition.description }}</span>
            </button>
          </div>
        </template>
      </section>

      <!-- 右：事件配置 -->
      <aside class="lc-eventflow__settings" aria-label="事件配置">
        <div class="lc-eventflow__column-head">
          <span class="lc-eventflow__column-title">事件配置</span>
        </div>

        <div v-if="!currentConnection" class="lc-eventflow__empty lc-eventflow__empty--block">
          选择左侧事件后查看配置
        </div>

        <div v-else class="lc-eventflow__settings-scroll">
          <div class="lc-eventflow__setting-row">
            <span class="lc-eventflow__setting-label">触发条件</span>
            <span class="lc-eventflow__setting-value" :title="triggerSummary">
              {{ triggerSummary }}
            </span>
            <button
              class="lc-eventflow__more"
              type="button"
              aria-label="编辑触发条件"
              title="编辑触发条件"
              :aria-expanded="expandedSection === 'trigger'"
              @click="toggleSection('trigger')"
            >
              …
            </button>
          </div>

          <div v-if="expandedSection === 'trigger'" class="lc-eventflow__expander">
            <label class="lc-eventflow__field">
              <span class="lc-eventflow__field-label">事件名</span>
              <input
                type="text"
                :value="currentConnection.eventName"
                @change="commitEventName"
              />
            </label>

            <label class="lc-eventflow__switch-row">
              <span>启用事件</span>
              <span class="lc-eventflow__switch">
                <input
                  type="checkbox"
                  :checked="currentConnection.enabled"
                  aria-label="启用当前事件"
                  @change="toggleCurrentConnectionEnabled($event)"
                />
                <span aria-hidden="true"></span>
              </span>
            </label>
          </div>

          <div class="lc-eventflow__setting-row">
            <span class="lc-eventflow__setting-label">执行动作</span>
            <span
              class="lc-eventflow__setting-value"
              :class="{ 'is-empty': !selectedActionId }"
              :title="selectedActionSummary"
            >
              {{ selectedActionSummary }}
            </span>
            <button
              class="lc-eventflow__more"
              type="button"
              aria-label="编辑执行动作"
              title="编辑执行动作"
              :aria-expanded="expandedSection === 'action'"
              @click="toggleSection('action')"
            >
              …
            </button>
          </div>

          <div v-if="expandedSection === 'action'" class="lc-eventflow__expander">
            <p v-if="!selectedActionId" class="lc-eventflow__empty">
              在中间动作链中点选一个动作
            </p>

            <p v-else-if="!selectedAction" class="lc-eventflow__error" role="alert">
              该动作定义已丢失，可在动作链中移除引用
            </p>

            <template v-else>
              <div class="lc-eventflow__action-head">
                <span class="lc-eventflow__badge">{{ selectedAction.type }}</span>
                <code class="lc-eventflow__action-id">{{ selectedAction.id }}</code>
              </div>

              <label class="lc-eventflow__field">
                <span class="lc-eventflow__field-label">名称</span>
                <input
                  type="text"
                  placeholder="缺省取动作类型标题"
                  :value="selectedAction.name ?? ''"
                  @change="commitActionName"
                />
              </label>

              <template v-if="selectedDefinition">
                <template v-for="field in selectedDefinition.fields" :key="field.key">
                  <label v-if="field.kind === 'toggle'" class="lc-eventflow__check">
                    <input
                      type="checkbox"
                      :checked="fieldChecked(field)"
                      @change="onFieldChange(field, $event)"
                    />
                    <span>{{ field.label }}</span>
                  </label>

                  <label v-else class="lc-eventflow__field">
                    <span class="lc-eventflow__field-label">
                      {{ field.label }}
                      <em v-if="field.required" aria-hidden="true">*</em>
                    </span>

                    <select
                      v-if="field.kind === 'select'"
                      :value="fieldSelectValue(field)"
                      @change="onFieldChange(field, $event)"
                    >
                      <option value="" disabled>未设置</option>
                      <option
                        v-for="option in field.options ?? []"
                        :key="option.value"
                        :value="option.value"
                      >
                        {{ option.label }}
                      </option>
                      <option
                        v-if="isUnlistedSelectValue(field)"
                        :value="fieldSelectValue(field)"
                      >
                        {{ fieldSelectValue(field) }}
                      </option>
                    </select>

                    <textarea
                      v-else-if="field.kind === 'json'"
                      rows="4"
                      spellcheck="false"
                      :placeholder="field.placeholder ?? '{ }'"
                      :value="jsonText(field)"
                      @input="onJsonInput(field, $event)"
                      @change="commitJson(field)"
                    />

                    <select
                      v-else-if="field.kind === 'action'"
                      :value="fieldSelectValue(field)"
                      @change="onFieldChange(field, $event)"
                    >
                      <option value="">不执行</option>
                      <option
                        v-for="option in actionOptions"
                        :key="option.value"
                        :value="option.value"
                      >
                        {{ option.label }}
                      </option>
                      <option
                        v-if="isUnlistedSelectValue(field)"
                        :value="fieldSelectValue(field)"
                      >
                        {{ fieldSelectValue(field) }}（动作已删除）
                      </option>
                    </select>

                    <input
                      v-else-if="field.kind === 'number'"
                      type="number"
                      :placeholder="field.placeholder"
                      :value="fieldNumber(field)"
                      @change="onFieldChange(field, $event)"
                    />

                    <input
                      v-else
                      type="text"
                      :placeholder="field.placeholder"
                      :value="fieldText(field)"
                      @change="onFieldChange(field, $event)"
                    />

                    <span
                      v-if="field.kind === 'json' && jsonErrorFor(field)"
                      class="lc-eventflow__error"
                      role="alert"
                    >
                      {{ jsonErrorFor(field) }}
                    </span>
                  </label>
                </template>
              </template>

              <p v-else class="lc-eventflow__hint">
                自定义动作类型「{{ selectedAction.type }}」，没有可渲染的内置字段
              </p>

              <div class="lc-eventflow__field">
                <span class="lc-eventflow__field-label">执行条件</span>
                <ConditionEditor
                  v-model="conditionDraft"
                  :functions="expressionFunctions"
                  :symbols="expressionSymbols"
                  aria-label="动作执行条件"
                  placeholder="留空表示无条件执行，如 count > 0"
                  :min-height="52"
                  @blur="commitConditionDraft"
                />
              </div>
            </template>
          </div>

          <div class="lc-eventflow__setting-row">
            <span class="lc-eventflow__setting-label">启用事件</span>
            <span class="lc-eventflow__setting-value"></span>
            <label
              class="lc-eventflow__switch"
              :title="currentConnection.enabled ? '已启用' : '已停用'"
            >
              <input
                type="checkbox"
                :checked="currentConnection.enabled"
                aria-label="启用当前事件"
                @change="toggleCurrentConnectionEnabled($event)"
              />
              <span aria-hidden="true"></span>
            </label>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<!--
  样式按拆分前单一 style 块的分节顺序拆到 styles/*.css：
  块顺序即层叠顺序，新增样式请追加到末尾，不要插进中间。
-->
<style scoped src="./styles/base.css"></style>
<style scoped src="./styles/tabs.css"></style>
<style scoped src="./styles/layout.css"></style>
<style scoped src="./styles/events.css"></style>
<style scoped src="./styles/switch.css"></style>
<style scoped src="./styles/chain.css"></style>
<style scoped src="./styles/card.css"></style>
<style scoped src="./styles/picker.css"></style>
<style scoped src="./styles/settings.css"></style>
<style scoped src="./styles/states.css"></style>
