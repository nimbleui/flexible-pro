import { defineComponent, h } from 'vue'

/**
 * 基础物料示例：不依赖设计器 UI。
 *
 * 物料组件只消费自身 props，不读取 Context。交互走标准 emit：组件把自己触发的
 * 事件名与参数在 manifest 的 `events` 里声明出来，由运行时渲染器接给动作执行器——
 * 画布上的选中、拖拽等设计器交互仍由画布插件统一处理，物料不参与。
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

/** 按钮配色：一个 `tone` 取值对应的一组样式 */
interface ButtonTone {
  background: string
  borderColor: string
  color: string
}

const BUTTON_TONES: Record<string, ButtonTone> = {
  primary: { background: '#2f6bff', borderColor: '#2f6bff', color: '#ffffff' },
  neutral: { background: '#ffffff', borderColor: 'rgba(37, 99, 235, 0.35)', color: '#1e293b' },
  danger: { background: '#dc2626', borderColor: '#dc2626', color: '#ffffff' },
}

/** 未知 `tone` 取值回落到主色：属性面板允许写表达式，运行期可能拿到没预料到的字符串 */
function toneOf(name: string): ButtonTone {
  return BUTTON_TONES[name] ?? BUTTON_TONES.primary
}

/**
 * 按钮：基础物料里唯一对外发事件的组件。
 *
 * `click` 刻意不带参数——按钮点击本身不产生页面需要的数据，文案是页面自己知道的
 * 属性。需要把值交给动作链的交互（例如输入框的 `change`）应当在 manifest 里声明
 * `parameters`，运行时按位置折叠成表达式里的 `event`。
 */
export const Button = defineComponent({
  name: 'LcMaterialButton',
  props: {
    /** 按钮文案 */
    label: { type: String, default: '按钮' },
    /** 配色：primary / neutral / danger */
    tone: { type: String, default: 'primary' },
    /** 禁用态；禁用后不再 emit click */
    disabled: { type: Boolean, default: false },
  },
  emits: {
    click: () => true,
  },
  setup(props, { emit }) {
    return () => {
      const tone = toneOf(props.tone)

      return h(
        'button',
        {
          type: 'button',
          class: 'lc-material-button',
          disabled: props.disabled,
          style: {
            width: '100%',
            height: '100%',
            boxSizing: 'border-box',
            padding: '0 14px',
            border: `1px solid ${tone.borderColor}`,
            borderRadius: '8px',
            background: tone.background,
            color: tone.color,
            fontSize: '13px',
            fontWeight: '500',
            cursor: props.disabled ? 'not-allowed' : 'pointer',
            opacity: props.disabled ? '0.5' : '1',
          },
          onClick: () => {
            if (props.disabled) return
            emit('click')
          },
        },
        props.label,
      )
    }
  },
})

/**
 * 插槽出口：复合组件蓝图里的内容接收区。
 *
 * 它不渲染内容本身——页面填进来的内容由复合组件的覆盖层按实例坐标绘制，
 * 位置归页面。本物料的作用是把「这一格收哪个插槽、在什么区域」画在蓝图上：
 * 作者据此摆放接收区，运行时则据此决定该插槽要不要显示。
 */
export const SlotOutlet = defineComponent({
  name: 'LcMaterialSlotOutlet',
  props: {
    /** 对应实例内容里的插槽名 */
    name: { type: String, default: 'default' },
  },
  setup(props) {
    return () =>
      h(
        'div',
        {
          class: 'lc-material-slot-outlet',
          style: {
            width: '100%',
            height: '100%',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px dashed rgba(47, 140, 255, 0.55)',
            borderRadius: '8px',
            background: 'rgba(47, 140, 255, 0.06)',
            color: '#2f8cff',
            fontSize: '12px',
            overflow: 'hidden',
          },
        },
        `插槽 · ${props.name}`,
      )
  },
})
