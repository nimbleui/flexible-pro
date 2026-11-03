<script setup lang="ts">
import { computed } from 'vue'
import type { CanvasView } from '../core/types'
import { formatZoom } from '../core/format'

const props = defineProps<{
  /** 画布快照；没有画布上下文时为 null */
  view: CanvasView | null
}>()

/** 长 id 列表只展示前若干个，避免把面板撑成一张节点清单。 */
const PREVIEW_LIMIT = 12

const rotationDegrees = computed(() => {
  if (!props.view) return '0°'
  return `${((props.view.viewport.rotation * 180) / Math.PI).toFixed(1)}°`
})

/**
 * 截断长 id 列表：面板只展示前 `limit` 条，其余折算成「还有多少条」。
 *
 * 快照本身不截断（`scene.order` 是完整登记顺序），截断只发生在展示层，
 * 这样「数得清」和「看得下」两件事不会互相妥协。
 */
function preview(
  ids: readonly string[],
  limit = PREVIEW_LIMIT,
): {
  /** 实际渲染的前若干条，长度不超过 limit */
  shown: string[]
  /** 被截断掉的条数；不大于 0 时不展示省略提示 */
  rest: number
} {
  return { shown: ids.slice(0, limit), rest: Math.max(0, ids.length - limit) }
}
</script>

<template>
  <div>
    <div v-if="!view" class="lc-devtools__empty">
      没有画布上下文。Realm 与画布层由 fork 创建，宿主需要把画布上下文传给面板。
    </div>

    <template v-else>
      <section class="lc-devtools__section">
        <h3 class="lc-devtools__section-title">视口</h3>
        <dl class="lc-canvas__kv">
          <dt>缩放</dt>
          <dd class="lc-devtools__mono">{{ formatZoom(view.viewport.zoom) }}</dd>
          <dt>平移</dt>
          <dd class="lc-devtools__mono">
            x {{ view.viewport.x.toFixed(1) }} · y {{ view.viewport.y.toFixed(1) }}
          </dd>
          <dt>旋转</dt>
          <dd class="lc-devtools__mono">{{ rotationDegrees }}</dd>
          <dt>可视区</dt>
          <dd class="lc-devtools__mono">
            {{ view.viewport.width.toFixed(0) }} × {{ view.viewport.height.toFixed(0) }} px
          </dd>
        </dl>
      </section>

      <section v-if="view.document" class="lc-devtools__section">
        <h3 class="lc-devtools__section-title">文档</h3>
        <dl class="lc-canvas__kv">
          <dt>标题</dt>
          <dd>{{ view.document.title }}</dd>
          <dt>文档 id</dt>
          <dd class="lc-devtools__mono">{{ view.document.id }}</dd>
          <dt>schema</dt>
          <dd class="lc-devtools__mono">
            v{{ view.document.schemaVersion }} · 修订 {{ view.document.revision }} ·
            {{ view.document.nodeCount }} 节点
          </dd>
          <dt>未保存</dt>
          <dd>{{ view.document.dirty ? '有变更' : '已同步' }}</dd>
          <template v-if="view.history">
            <dt>历史</dt>
            <dd class="lc-devtools__mono">
              {{ view.history.count }} 条 · 可撤销 {{ view.history.canUndo ? '是' : '否' }} ·
              可重做
              {{ view.history.canRedo ? '是' : '否' }}
            </dd>
          </template>
        </dl>
      </section>

      <section class="lc-devtools__section">
        <h3 class="lc-devtools__section-title">
          选中
          <span class="lc-devtools__muted">{{ view.selection.ids.length }} 个</span>
        </h3>
        <p v-if="view.selection.ids.length === 0" class="lc-devtools__muted">
          当前没有选中节点。
        </p>
        <div v-else class="lc-canvas__chips">
          <span
            v-if="view.selection.primary"
            class="lc-devtools__chip lc-devtools__chip--reserved"
          >
            主选中 {{ view.selection.primary }}
          </span>
          <span
            v-for="id in preview(view.selection.ids).shown"
            :key="id"
            class="lc-devtools__chip"
          >
            {{ id }}
          </span>
          <span v-if="preview(view.selection.ids).rest" class="lc-devtools__muted">
            还有 {{ preview(view.selection.ids).rest }} 个
          </span>
        </div>
      </section>

      <section class="lc-devtools__section">
        <h3 class="lc-devtools__section-title">隐藏 / 锁定</h3>
        <div class="lc-canvas__chips">
          <span class="lc-devtools__muted">隐藏 {{ view.flags.hidden.length }}</span>
          <span
            v-for="id in preview(view.flags.hidden).shown"
            :key="`h-${id}`"
            class="lc-devtools__chip"
          >
            {{ id }}
          </span>
          <span v-if="preview(view.flags.hidden).rest" class="lc-devtools__muted">
            +{{ preview(view.flags.hidden).rest }}
          </span>
        </div>
        <div class="lc-canvas__chips">
          <span class="lc-devtools__muted">锁定 {{ view.flags.locked.length }}</span>
          <span
            v-for="id in preview(view.flags.locked).shown"
            :key="`l-${id}`"
            class="lc-devtools__chip"
          >
            {{ id }}
          </span>
          <span v-if="preview(view.flags.locked).rest" class="lc-devtools__muted">
            +{{ preview(view.flags.locked).rest }}
          </span>
        </div>
      </section>

      <section class="lc-devtools__section">
        <h3 class="lc-devtools__section-title">
          覆盖层
          <span class="lc-devtools__muted">{{ view.layers.length }} 个</span>
        </h3>
        <table class="lc-devtools__table">
          <thead>
            <tr>
              <th scope="col">id</th>
              <th scope="col">band</th>
              <th scope="col">z</th>
              <th scope="col">指针</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="layer in view.layers" :key="layer.id">
              <td class="lc-devtools__mono">{{ layer.id }}</td>
              <td>{{ layer.band }}</td>
              <td>{{ layer.zIndex }}</td>
              <td class="lc-devtools__muted">{{ layer.pointerEvents }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="lc-devtools__section">
        <h3 class="lc-devtools__section-title">
          交互处理器
          <span class="lc-devtools__muted">{{ view.handlers.length }} 个</span>
        </h3>
        <table class="lc-devtools__table">
          <thead>
            <tr>
              <th scope="col">id</th>
              <th scope="col">阶段</th>
              <th scope="col">优先级</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="handler in view.handlers" :key="handler.id">
              <td class="lc-devtools__mono">{{ handler.id }}</td>
              <td>{{ handler.phase }}</td>
              <td>{{ handler.priority }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="lc-devtools__section">
        <h3 class="lc-devtools__section-title">
          场景
          <span class="lc-devtools__muted">{{ view.scene.count }} 个节点</span>
        </h3>
        <p class="lc-canvas__bounds lc-devtools__mono">
          根包围盒 {{ view.scene.rootBounds.x.toFixed(0) }},
          {{ view.scene.rootBounds.y.toFixed(0) }} ·
          {{ view.scene.rootBounds.width.toFixed(0) }} ×
          {{ view.scene.rootBounds.height.toFixed(0) }}
        </p>
        <div class="lc-canvas__chips">
          <span
            v-for="id in preview(view.scene.order).shown"
            :key="id"
            class="lc-devtools__chip"
          >
            {{ id }}
          </span>
          <span v-if="preview(view.scene.order).rest" class="lc-devtools__muted">
            还有 {{ preview(view.scene.order).rest }} 个
          </span>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.lc-canvas__kv {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 2px 8px;
  margin: 0;
}

.lc-canvas__kv dt {
  color: var(--lc-text-secondary);
}

.lc-canvas__kv dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.lc-canvas__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}

.lc-canvas__bounds {
  margin: 0 0 4px;
  font-size: 11px;
}
</style>
