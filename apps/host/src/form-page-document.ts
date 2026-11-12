import type { ComponentSchema, PageSchema } from '@lc/schema'
import { SCHEMA_VERSION, createExpression } from '@lc/schema'

/**
 * 自定义表单演示文档。
 *
 * 一句话目标：把「表单」整体配置成一个**自定义组件**，并给它配上「方法」。
 *
 * 在你们这套 schema 里，"表单 = 自定义组件" 与 "方法" 各自落点如下：
 *  - 自定义组件：`PageSchema.components` 里登记 `SignupForm`（ComponentSchema），
 *    页面只放一个节点引用它；它的「壳 + 插槽 + 可配置属性」由组件自己定义，可跨页复用。
 *    表单的交互控件（提交/重置按钮、字段行）通过组件声明的具名插槽 `body` 落到页面节点上，
 *    从而复用页面级的事件连接（connections）——这是当前渲染器能跑通自定义组件内交互的唯一干净路径
 *    （自包含蓝图里的按钮点击无法回连到页面动作，事件流面板也只认页面节点 id）。
 *  - 方法有两层：
 *      · 声明式纯函数 `functions`：isEmail / maskPhone / validateForm / sampleForm，
 *        供表达式与动作直接调用，无副作用；
 *      · 事件驱动动作 `actions` + `connections`：提交链路（校验 → 分支 → 写状态 → 提示）、
 *        重置链路，挂在按钮的 `click` 上。
 *
 * 字段本身因为没有独立输入框物料（基础物料只有 Box/Text/Button…），这里用变量 + 文本展示来表达，
 * 重点演示「表单 = 自定义组件 + 方法」这一组合链路，跑通后即可沿此接真实输入控件或数据源。
 *
 * 预览页上可直接验证：
 *  - page → pageLoad：预填示例数据，并把提交态清回初始；
 *  - 提交按钮 click → validateForm 校验 → 写 data.errors → 按错误数分支：
 *      无错则标记已提交并 toast（手机号脱敏），有错则提示几处未通过；
 *  - 重置按钮 click → 清空表单与错误并 toast。
 */

/**
 * 自定义表单组件：只负责「壳 + 插槽 + 可配置标题」，字段控件由页面经 `body` 插槽注入。
 *
 * 与页面级 `PageSchema.components` 共用同一份 ComponentSchema 结构；要让它在渲染器里真正出图，
 * 还需要把它注册进物料服务（见 `bootstrap.ts` 的演示注册），因为渲染器按 `componentName`
 * 查的是物料表，而不是页面级 `components` 数组——后者目前只被编辑器用来识别节点的事件/属性。
 */
const signupFormComponent: ComponentSchema = {
  meta: {
    name: 'SignupForm',
    title: '报名表单',
    group: 'Form',
    version: '1.0.0',
    description: '带标题与内容插槽的自定义表单外壳，字段与操作按钮由页面通过 body 插槽注入',
    icon: 'form',
  },
  // 蓝图根节点 id
  nodeId: 'formShell',
  nodes: {
    // 卡片外壳：页面落进来的内容会叠在它的坐标基准之上
    formShell: {
      id: 'formShell',
      componentName: 'Box',
      name: '表单卡片',
      children: ['formHeader', 'formSlot'],
      layout: { mode: 'absolute', rect: { x: 0, y: 0, width: 420, height: 360 }, zIndex: 0 },
      props: { fill: '#ffffff', stroke: 'rgba(15,23,42,0.08)', radius: 16, label: '' },
      style: { boxShadow: '0 24px 60px rgba(15,23,42,0.10)' },
    },
    // 标题读组件属性 `props.title`，演示自定义组件「可被配置」
    formHeader: {
      id: 'formHeader',
      componentName: 'Text',
      name: '表单标题',
      layout: { mode: 'absolute', rect: { x: 28, y: 24, width: 364, height: 32 }, zIndex: 1 },
      props: { text: '{{ props.title }}', fontSize: 20, weight: '700', color: '#0f172a' },
    },
    // 插槽出口：页面经 body 插槽注入的控件会叠在它对应的坐标区域
    formSlot: {
      id: 'formSlot',
      componentName: 'SlotOutlet',
      name: '表单内容插槽',
      layout: { mode: 'absolute', rect: { x: 28, y: 72, width: 364, height: 264 }, zIndex: 1 },
      props: { name: 'body' },
    },
  },
  // 声明 body 插槽 → 物料被标成容器，页面才能把内容拖/注入进来
  slots: [{ name: 'body', title: '表单内容', description: '页面把字段与操作按钮放进来' }],
  // 组件级可配置属性；页面节点传 title 即覆盖默认值
  defaultProps: { title: '报名表单' },
}

export { signupFormComponent }

export function createFormPageSchema(): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'page',

    nodes: {
      // 页面画幅（背景容器）
      page: {
        id: 'page',
        componentName: 'Box',
        name: '页面画幅',
        children: ['form', 'result'],
        layout: {
          mode: 'absolute',
          rect: { x: 40, y: 40, width: 520, height: 470 },
          zIndex: 0,
        },
        props: { fill: '#f8fafc', stroke: 'rgba(15,23,42,0.06)', radius: 20, label: '' },
      },

      // 表单 = 自定义组件实例；通过 slots.body 把字段与按钮注入组件插槽
      form: {
        id: 'form',
        componentName: 'SignupForm',
        name: '报名表单',
        props: { title: '活动报名' },
        slots: {
          body: ['nameRow', 'emailRow', 'phoneRow', 'agreeRow', 'submitBtn', 'resetBtn'],
        },
        layout: {
          mode: 'absolute',
          rect: { x: 60, y: 60, width: 420, height: 360 },
          zIndex: 1,
        },
      },

      // 以下字段/按钮是「页面节点」，经 body 插槽叠在表单卡片内。
      // 它们的 rect 用世界坐标书写，且都落在卡片范围内（卡片世界坐标 x∈[60,480] y∈[60,420]）。
      nameRow: {
        id: 'nameRow',
        componentName: 'Box',
        name: '姓名行',
        children: ['nameLabel', 'nameValue'],
        layout: { mode: 'absolute', rect: { x: 92, y: 96, width: 356, height: 36 }, zIndex: 2 },
        props: { fill: '#f1f5f9', radius: 8, label: '' },
      },
      nameLabel: {
        id: 'nameLabel',
        componentName: 'Text',
        name: '姓名标签',
        layout: {
          mode: 'absolute',
          rect: { x: 104, y: 104, width: 72, height: 20 },
          zIndex: 3,
        },
        props: { text: '姓名', fontSize: 13, weight: '500', color: '#475569' },
      },
      nameValue: {
        id: 'nameValue',
        componentName: 'Text',
        name: '姓名值',
        layout: {
          mode: 'absolute',
          rect: { x: 184, y: 104, width: 252, height: 20 },
          zIndex: 3,
        },
        props: { text: '{{ data.form.name }}', fontSize: 13, color: '#0f172a' },
      },

      emailRow: {
        id: 'emailRow',
        componentName: 'Box',
        name: '邮箱行',
        children: ['emailLabel', 'emailValue'],
        layout: {
          mode: 'absolute',
          rect: { x: 92, y: 144, width: 356, height: 36 },
          zIndex: 2,
        },
        props: { fill: '#f1f5f9', radius: 8, label: '' },
      },
      emailLabel: {
        id: 'emailLabel',
        componentName: 'Text',
        name: '邮箱标签',
        layout: {
          mode: 'absolute',
          rect: { x: 104, y: 152, width: 72, height: 20 },
          zIndex: 3,
        },
        props: { text: '邮箱', fontSize: 13, weight: '500', color: '#475569' },
      },
      emailValue: {
        id: 'emailValue',
        componentName: 'Text',
        name: '邮箱值',
        layout: {
          mode: 'absolute',
          rect: { x: 184, y: 152, width: 252, height: 20 },
          zIndex: 3,
        },
        props: { text: '{{ data.form.email }}', fontSize: 13, color: '#0f172a' },
      },

      phoneRow: {
        id: 'phoneRow',
        componentName: 'Box',
        name: '手机号行',
        children: ['phoneLabel', 'phoneValue'],
        layout: {
          mode: 'absolute',
          rect: { x: 92, y: 192, width: 356, height: 36 },
          zIndex: 2,
        },
        props: { fill: '#f1f5f9', radius: 8, label: '' },
      },
      phoneLabel: {
        id: 'phoneLabel',
        componentName: 'Text',
        name: '手机号标签',
        layout: {
          mode: 'absolute',
          rect: { x: 104, y: 200, width: 72, height: 20 },
          zIndex: 3,
        },
        props: { text: '手机号', fontSize: 13, weight: '500', color: '#475569' },
      },
      phoneValue: {
        id: 'phoneValue',
        componentName: 'Text',
        name: '手机号值',
        layout: {
          mode: 'absolute',
          rect: { x: 184, y: 200, width: 252, height: 20 },
          zIndex: 3,
        },
        props: { text: '{{ maskPhone(data.form.phone) }}', fontSize: 13, color: '#0f172a' },
      },

      agreeRow: {
        id: 'agreeRow',
        componentName: 'Text',
        name: '条款同意态',
        layout: {
          mode: 'absolute',
          rect: { x: 92, y: 244, width: 356, height: 24 },
          zIndex: 2,
        },
        props: {
          text: '{{ data.form.agreed ? "✓ 已同意服务条款" : "✗ 未同意服务条款" }}',
          fontSize: 13,
          weight: '500',
          color: '{{ data.form.agreed ? "#047857" : "#b45309" }}',
        },
      },

      submitBtn: {
        id: 'submitBtn',
        componentName: 'Button',
        name: '提交按钮',
        layout: {
          mode: 'absolute',
          rect: { x: 92, y: 292, width: 160, height: 40 },
          zIndex: 3,
        },
        props: { label: '提交报名', tone: 'primary' },
      },
      resetBtn: {
        id: 'resetBtn',
        componentName: 'Button',
        name: '重置按钮',
        layout: {
          mode: 'absolute',
          rect: { x: 268, y: 292, width: 160, height: 40 },
          zIndex: 3,
        },
        props: { label: '重置', tone: 'neutral' },
      },

      // 结果行在卡片外（页面画幅直接子节点），展示提交后的反馈
      result: {
        id: 'result',
        componentName: 'Text',
        name: '提交结果',
        layout: {
          mode: 'absolute',
          rect: { x: 60, y: 440, width: 440, height: 24 },
          zIndex: 2,
        },
        props: {
          text: '{{ data.submitted ? ("已提交：" + maskPhone(data.form.phone)) : "尚未提交，填写后点「提交报名」" }}',
          fontSize: 13,
          color: '{{ data.submitted ? "#047857" : "#64748b" }}',
        },
      },
    },

    // 自定义组件登记在页面级 components（编辑器据此识别它的事件/属性）
    components: [signupFormComponent],

    // 方法 · 声明式纯函数（无副作用，供表达式与动作调用）
    functions: [
      {
        name: 'isEmail',
        title: '邮箱格式校验',
        params: ['v'],
        body: '/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v)',
        returns: { kind: 'boolean' },
        description: '判断字符串是否为合法邮箱',
      },
      {
        name: 'maskPhone',
        title: '手机号脱敏',
        params: ['v'],
        body: "v && v.length >= 7 ? v.slice(0, 3) + '****' + v.slice(-4) : (v || '')",
        returns: { kind: 'string' },
        description: '保留前 3 后 4，中间打码',
      },
      {
        name: 'validateForm',
        title: '表单校验',
        params: ['form'],
        // 函数作用域只看形参与已注册函数：这里用形参 form，不碰 data
        body: "((f) => { var e = {}; if (!isEmail(f.email || '')) e.email = '邮箱格式不正确'; if (!/^1\\d{10}$/.test(f.phone || '')) e.phone = '手机号需为 11 位数字'; if (!f.agreed) e.agree = '请先同意服务条款'; return e; })(form)",
        returns: { kind: 'object' },
        description: '返回错误字段对象，无错则为空对象',
      },
      {
        name: 'sampleForm',
        title: '示例数据',
        params: [],
        body: '({ name: "林墨", email: "lin@example.com", phone: "13800001234", agreed: true })',
        returns: {
          kind: 'object',
          fields: {
            name: { kind: 'string' },
            email: { kind: 'string' },
            phone: { kind: 'string' },
            agreed: { kind: 'boolean' },
          },
        },
        description: '页面加载时预填的示例表单',
      },
    ],

    // 方法 · 事件驱动动作（由 connections 触发）
    actions: {
      'prefill-form': {
        id: 'prefill-form',
        type: 'state.set',
        name: '预填示例数据',
        // 整串必须是表达式：写成普通字符串不会被当对象
        config: { key: 'form', value: createExpression('{{ sampleForm() }}') },
      },
      'clear-submitted': {
        id: 'clear-submitted',
        type: 'state.set',
        name: '清除提交态',
        config: { key: 'submitted', value: false },
      },
      'validate-form': {
        id: 'validate-form',
        type: 'state.set',
        name: '写入校验结果',
        config: { key: 'errors', value: createExpression('{{ validateForm(data.form) }}') },
      },
      'branch-submit': {
        id: 'branch-submit',
        type: 'flow.condition',
        name: '按校验结果分派',
        config: {
          expression: createExpression('{{ Object.keys(data.errors).length === 0 }}'),
          trueActionId: 'seq-submit-ok',
          falseActionId: 'toast-submit-fail',
        },
      },
      'seq-submit-ok': {
        id: 'seq-submit-ok',
        type: 'flow.sequence',
        name: '标记已提交并提示',
        config: { actionIds: ['mark-submitted', 'toast-submit-ok'] },
      },
      'mark-submitted': {
        id: 'mark-submitted',
        type: 'state.set',
        name: '标记已提交',
        config: { key: 'submitted', value: true },
      },
      'toast-submit-ok': {
        id: 'toast-submit-ok',
        type: 'ui.toast',
        name: '提交成功提示',
        config: { message: '报名已提交：{{ maskPhone(data.form.phone) }}', level: 'success' },
      },
      'toast-submit-fail': {
        id: 'toast-submit-fail',
        type: 'ui.toast',
        name: '校验失败提示',
        config: {
          message: '表单有 {{ Object.keys(data.errors).length }} 处未通过校验',
          level: 'warning',
        },
      },
      'reset-form': {
        id: 'reset-form',
        type: 'state.reset',
        name: '重置表单',
        config: { key: 'form' },
      },
      'reset-errors': {
        id: 'reset-errors',
        type: 'state.reset',
        name: '清空错误',
        config: { key: 'errors' },
      },
      'toast-reset': {
        id: 'toast-reset',
        type: 'ui.toast',
        name: '重置完成',
        config: { message: '表单已重置', level: 'info' },
      },
    },

    connections: {
      // 页面级事件：进页面即预填并把提交态清回初始
      'on-page-load': {
        id: 'on-page-load',
        sourceNodeId: 'page',
        eventName: 'pageLoad',
        actionIds: ['prefill-form', 'clear-submitted'],
        enabled: true,
      },
      // 提交按钮 click → 校验 → 按错误数分支
      'on-submit': {
        id: 'on-submit',
        sourceNodeId: 'submitBtn',
        eventName: 'click',
        actionIds: ['validate-form', 'branch-submit'],
        enabled: true,
      },
      // 重置按钮 click → 清空表单与错误并提示
      'on-reset': {
        id: 'on-reset',
        sourceNodeId: 'resetBtn',
        eventName: 'click',
        actionIds: ['reset-form', 'reset-errors', 'toast-reset'],
        enabled: true,
      },
    },

    // 表单字段、错误、提交态
    variables: [
      {
        name: 'form',
        type: {
          kind: 'object',
          fields: {
            name: { kind: 'string' },
            email: { kind: 'string' },
            phone: { kind: 'string' },
            agreed: { kind: 'boolean' },
          },
        },
        defaultValue: { name: '', email: '', phone: '', agreed: false },
        description: '表单字段',
      },
      {
        name: 'errors',
        type: { kind: 'object' },
        defaultValue: {},
        description: '校验错误字段',
      },
      {
        name: 'submitted',
        type: { kind: 'boolean' },
        defaultValue: false,
        description: '是否已提交',
      },
    ],

    metadata: {
      title: '自定义表单页',
      description: '表单配置成自定义组件（SignupForm）+ 声明式函数与事件方法',
    },
  }
}
