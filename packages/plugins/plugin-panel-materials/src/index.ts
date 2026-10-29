import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import type { MaterialEntry, MaterialService } from '@lc/contracts'
import { toMaterialDragType } from '@lc/contracts'
import { useAppContext } from '@lc/vue'

export { manifest } from './manifest'

/**
 * 物料面板（纯声明式面板插件）。
 *
 * 物料按 category 分组；拖拽时把物料名编码进 MIME，画布宿主的 dragover
 * 只能读取 types，因此不依赖全局状态即可还原物料名。
 */
export default defineComponent({
  name: 'LcMaterialPanel',
  props: {
    /** 宿主传入的只读上下文；面板实际使用注入的 Context */
    context: { type: Object, default: undefined },
  },
  setup() {
    const ctx = useAppContext()
    const material = ctx.get<MaterialService>('material')
    const version = ref(0)
    let off: { dispose(): void } | null = null

    onMounted(() => {
      if (!material) return
      off = material.onDidChange(() => {
        version.value += 1
      })
    })

    onUnmounted(() => {
      off?.dispose()
      off = null
    })

    function groups(): Array<{ category: string; items: MaterialEntry[] }> {
      version.value
      const entries = material?.list() ?? []
      const grouped = new Map<string, MaterialEntry[]>()
      for (const entry of entries) {
        const list = grouped.get(entry.category) ?? []
        list.push(entry)
        grouped.set(entry.category, list)
      }
      return [...grouped.entries()].map(([category, items]) => ({ category, items }))
    }

    function onDragStart(event: DragEvent, entry: MaterialEntry): void {
      if (!event.dataTransfer) return
      event.dataTransfer.setData(toMaterialDragType(entry.name), entry.name)
      event.dataTransfer.setData('text/plain', entry.name)
      event.dataTransfer.effectAllowed = 'copy'
    }

    return () => {
      const sections = groups()

      return h(
        'div',
        {
          class: 'lc-materials',
          style: { display: 'flex', flexDirection: 'column', gap: '10px' },
        },
        [
          ...sections.map((section) =>
            h(
              'div',
              {
                key: section.category,
                style: { display: 'flex', flexDirection: 'column', gap: '6px' },
              },
              [
                h(
                  'div',
                  { style: { fontSize: '11px', color: '#94a3b8', fontWeight: 600 } },
                  section.category,
                ),
                ...section.items.map((entry) =>
                  h(
                    'button',
                    {
                      key: entry.name,
                      type: 'button',
                      class: 'lc-materials__item',
                      draggable: true,
                      title: entry.title,
                      'data-material': entry.name,
                      onDragstart: (event: DragEvent) => onDragStart(event, entry),
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 10px',
                        border: '1px solid var(--lc-border, #e2e8f0)',
                        borderRadius: '7px',
                        background: 'var(--lc-surface, #fff)',
                        color: 'var(--lc-text, #0f172a)',
                        fontSize: '12px',
                        cursor: 'grab',
                        textAlign: 'left',
                      },
                    },
                    entry.title,
                  ),
                ),
              ],
            ),
          ),
          h(
            'div',
            { style: { fontSize: '11px', color: '#94a3b8', lineHeight: 1.5 } },
            '拖拽物料到画布空白处或容器内',
          ),
        ],
      )
    }
  },
})
