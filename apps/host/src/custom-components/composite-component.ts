import type { Component, InjectionKey } from 'vue'
import { defineComponent, h, inject, provide } from 'vue'
import type { ComponentSchema } from '@lc/schema'
import type { SlotContent } from '@lc/vue'
import { SchemaPreview } from '@lc/vue'

/**
 * 复合自定义组件的运行时实现。
 *
 * 画布对物料只做一件事：把求值后的节点属性当 props 传进来。自定义组件没有自己的
 * 代码，它的「实现」就是把自己的蓝图交给 `SchemaPreview` 再渲染一遍，因此属性统一
 * 落在表达式作用域的 `props` 命名空间下，蓝图里用 `{{ props.xxx }}` 引用。
 *
 * 页面填进具名插槽的内容走 Vue 的 slots 通道进来，再交给 `SchemaPreview` 的
 * `content`：组件因此真的拥有「内容归谁、显不显示」的决定权，而不是像以前那样
 * 由画布把内容平铺成自己的兄弟节点。
 */

/**
 * 复合组件嵌套上限。
 *
 * 蓝图引用别的自定义组件时，渲染深度只有在这里能看见：`buildRenderTree` 的深度上限
 * 管的是单份节点图内部，跨物料的相互引用（A 里有 B、B 里又有 A）不在它的视野里。
 */
const MAX_NESTING_DEPTH = 8

const COMPOSITE_DEPTH: InjectionKey<number> = Symbol('lc-composite-depth')

/**
 * 由组件定义生成可注册的 Vue 组件。
 *
 * 返回的是无 props 声明的组件：画布传入的属性全部进入 attrs，避免在这里维护一份与
 * 属性定义表重复的运行时 props 声明（那份声明只能表达「有没有这个键」，类型信息早在
 * 表达式求值阶段就用完了）。
 *
 * @param definition 组件定义；引用方在保存时会整体替换，因此这里按引用持有，不再拷贝
 * @returns 交给物料服务的组件对象
 */
export function createCompositeComponent(definition: ComponentSchema): Component {
  return defineComponent({
    name: `LcCustom-${definition.meta.name}`,
    inheritAttrs: false,

    setup(_props, { attrs, slots }) {
      const depth = inject(COMPOSITE_DEPTH, 0)

      if (depth >= MAX_NESTING_DEPTH) {
        return () =>
          h(
            'div',
            { class: 'lc-composite-overflow' },
            `自定义组件嵌套超过 ${MAX_NESTING_DEPTH} 层`,
          )
      }

      provide(COMPOSITE_DEPTH, depth + 1)

      const nodeId = definition.nodeId
      const nodes = definition.nodes
      const declared = definition.slots ?? []

      return () => {
        // 只转声明过且真有内容的插槽：Vue 的 slots 对象带内部标记（`_`），
        // 整体透传会被当成一个名叫 `_` 的插槽
        const content: SlotContent = {}
        for (const slot of declared) {
          const factory = slots[slot.name]
          if (factory) content[slot.name] = factory
        }

        return h(SchemaPreview, {
          nodeId,
          nodes,
          scope: { props: { ...attrs } },
          content: Object.keys(content).length === 0 ? undefined : content,
          // 画布给的就是实例的真实尺寸：改尺寸要按约束重排，不能整张图缩放
          fit: false,
        })
      }
    },
  })
}
