import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import type { CommandService, MaterialEntry, MaterialService } from '@lc/contracts'
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
    const command = ctx.get<CommandService>('command')
    const version = ref(0)
    /** 物料服务的订阅句柄；onMounted 注册、onUnmounted 释放，只保留一条 */
    let off: {
      /** 解绑本面板的 material 监听，重复调用不安全 */
      dispose(): void
    } | null = null

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

    /**
     * 按 category 分组的物料。
     *
     * 写成函数而不是 computed：渲染函数每次执行都直接读 `version`，
     * 分组结果就不必再占一份响应式缓存，也不会出现「订阅已更新但 computed 未失效」的时序缝隙。
     * 分组顺序即 `material.list()` 的返回顺序，不额外排序。
     *
     * @returns category 直接取物料的 category（空串也是一组）；items 为该分组下的物料条目，保持 list 的原始顺序
     */
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
      // 命令型物料是编辑器入口而不是画布节点，不允许拖出幽灵节点
      if (entry.clickCommand) {
        event.preventDefault()
        return
      }
      if (!event.dataTransfer) return
      event.dataTransfer.setData(toMaterialDragType(entry.name), entry.name)
      event.dataTransfer.setData('text/plain', entry.name)
      event.dataTransfer.effectAllowed = 'copy'
    }

    function onClick(entry: MaterialEntry): void {
      if (!entry.clickCommand || !command) return
      void command.execute(entry.clickCommand)
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
                      draggable: entry.clickCommand === undefined,
                      title: entry.clickCommand ? `${entry.title}（点击打开）` : entry.title,
                      'data-material': entry.name,
                      onClick: () => onClick(entry),
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
                        cursor: entry.clickCommand ? 'pointer' : 'grab',
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
