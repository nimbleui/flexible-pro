import { defineComponent, h } from 'vue'

/**
 * 基础物料示例：纯展示组件，不依赖设计器 UI。
 *
 * 物料组件只消费自身 props，不读取 Context；交互由画布插件统一处理。
 */

export const Box = defineComponent({
  name: 'LcMaterialBox',
  props: {
    /** 背景色 */
    fill: { type: String, default: '#eef2ff' },
    /** 边框颜色 */
    stroke: { type: String, default: 'rgba(37, 99, 235, 0.25)' },
    /** 圆角半径（像素） */
    radius: { type: Number, default: 10 },
    /** 居中文本 */
    label: { type: String, default: '' },
  },
  setup(props) {
    return () =>
      h(
        'div',
        {
          class: 'lc-material-box',
          style: {
            width: '100%',
            height: '100%',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: props.fill,
            border: `1px solid ${props.stroke}`,
            borderRadius: `${props.radius}px`,
            color: '#1e293b',
            fontSize: '13px',
            overflow: 'hidden',
          },
        },
        props.label,
      )
  },
})

export const Text = defineComponent({
  name: 'LcMaterialText',
  props: {
    /** 文本内容 */
    text: { type: String, default: '文本' },
    /** 字体大小（像素） */
    fontSize: { type: Number, default: 14 },
    /** 字重 */
    weight: { type: String, default: '500' },
    /** 文字颜色 */
    color: { type: String, default: '#0f172a' },
    /** 对齐方式 */
    align: { type: String, default: 'left' },
  },
  setup(props) {
    return () =>
      h(
        'div',
        {
          class: 'lc-material-text',
          style: {
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent:
              props.align === 'center'
                ? 'center'
                : props.align === 'right'
                  ? 'flex-end'
                  : 'flex-start',
            color: props.color,
            fontSize: `${props.fontSize}px`,
            fontWeight: props.weight,
            whiteSpace: 'pre-wrap',
            overflow: 'hidden',
          },
        },
        props.text,
      )
  },
})

export const Circle = defineComponent({
  name: 'LcMaterialCircle',
  props: {
    /** 填充色 */
    fill: { type: String, default: '#fef3c7' },
    /** 描边色 */
    stroke: { type: String, default: 'rgba(217, 119, 6, 0.35)' },
  },
  setup(props) {
    return () =>
      h('div', {
        class: 'lc-material-circle',
        style: {
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          background: props.fill,
          border: `1px solid ${props.stroke}`,
          borderRadius: '50%',
        },
      })
  },
})

/**
 * 分组：只有层叠与选中语义，画面上完全透明。
 *
 * 子节点由渲染器画在同一个 DOM 层里，位置用世界坐标补偿，所以分组本身不需要
 * 布局能力；`pointer-events: none` 保证它不抢子节点的命中。
 */
export const Group = defineComponent({
  name: 'LcMaterialGroup',
  setup() {
    return () =>
      h('div', {
        class: 'lc-material-group',
        style: { width: '100%', height: '100%', pointerEvents: 'none' },
      })
  },
})
