import type { PageSchema } from '@lc/schema'
import { SCHEMA_VERSION, createExpression } from '@lc/schema'

/**
 * 事件链演示文档。
 *
 * 覆盖一条真实页面链需要的所有环节，预览页上可直接验证：
 *  - 节点事件（Button.click）与页面级事件（page → pageLoad）两条触发路径；
 *  - `state.set` 写运行时状态、`Text` 节点用 `{{ }}` 读回来，形成「点了就变」的反馈；
 *  - `flow.condition` 按当前状态分派到两条不同的 `ui.toast`；
 *  - `state.reset` 演示回到声明的默认值。
 *
 * 刻意只用基础物料 + 内置动作：任何一处能跑，说明对应那层接线是真的通了；
 * 跑不动就能沿「事件是否 emit → 连接是否匹配 → 动作是否执行 → 状态是否回流到渲染」
 * 逐段定位。
 */
export function createEventDemoSchema(): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'board',
    nodes: {
      board: {
        id: 'board',
        componentName: 'Box',
        children: ['heading', 'counter', 'verdict', 'plusButton', 'resetButton'],
        layout: {
          mode: 'absolute',
          rect: { x: 80, y: 60, width: 560, height: 300 },
          zIndex: 0,
        },
        props: { fill: '#ffffff', stroke: 'rgba(15, 23, 42, 0.08)', radius: 18, label: '' },
        style: { boxShadow: '0 24px 60px rgba(15, 23, 42, 0.10)' },
      },
      heading: {
        id: 'heading',
        componentName: 'Text',
        layout: {
          mode: 'absolute',
          rect: { x: 112, y: 92, width: 496, height: 32 },
          zIndex: 2,
        },
        props: { text: '事件链演示', fontSize: 20, weight: '700', color: '#0f172a' },
      },
      counter: {
        id: 'counter',
        componentName: 'Text',
        name: '计数显示',
        layout: {
          mode: 'absolute',
          rect: { x: 112, y: 136, width: 496, height: 32 },
          zIndex: 2,
        },
        props: {
          // 整串表达式：求值结果保留数字类型，渲染时再与静态文本拼接
          text: '当前计数：{{ data.count }}',
          fontSize: 16,
          weight: '500',
          color: '#1e293b',
        },
      },
      verdict: {
        id: 'verdict',
        componentName: 'Text',
        name: '阈值提示',
        layout: {
          mode: 'absolute',
          rect: { x: 112, y: 172, width: 496, height: 26 },
          zIndex: 2,
        },
        props: {
          text: '{{ data.count > 5 ? "已超过 5" : "还没超过 5" }}',
          fontSize: 13,
          color: '#64748b',
        },
      },
      plusButton: {
        id: 'plusButton',
        componentName: 'Button',
        name: '加一按钮',
        layout: {
          mode: 'absolute',
          rect: { x: 112, y: 224, width: 120, height: 40 },
          zIndex: 3,
        },
        props: { label: '加一', tone: 'primary' },
      },
      resetButton: {
        id: 'resetButton',
        componentName: 'Button',
        name: '重置按钮',
        layout: {
          mode: 'absolute',
          rect: { x: 248, y: 224, width: 120, height: 40 },
          zIndex: 3,
        },
        props: { label: '重置', tone: 'neutral' },
      },
    },
    components: [],

    variables: [
      { name: 'count', type: { kind: 'number' }, defaultValue: 0, description: '点击次数' },
    ],

    actions: {
      'set-count': {
        id: 'set-count',
        type: 'state.set',
        name: '写入初始计数',
        config: { key: 'count', value: 2 },
      },
      increase: {
        id: 'increase',
        type: 'state.set',
        name: '计数加一',
        // 整串必须存成表达式对象：写成普通字符串会被按模板插值成 "1"，
        // 下一次「1 + 1」就变成字符串拼接
        config: { key: 'count', value: createExpression('{{ data.count + 1 }}') },
      },
      'reset-count': {
        id: 'reset-count',
        type: 'state.reset',
        name: '清零',
        config: { key: 'count' },
      },
      'branch-threshold': {
        id: 'branch-threshold',
        type: 'flow.condition',
        name: '按阈值分派',
        config: {
          expression: createExpression('{{ data.count > 5 }}'),
          trueActionId: 'toast-over',
          falseActionId: 'toast-normal',
        },
      },
      'toast-over': {
        id: 'toast-over',
        type: 'ui.toast',
        name: '超限提示',
        config: { message: '计数已超过 5', level: 'warning' },
      },
      'toast-normal': {
        id: 'toast-normal',
        type: 'ui.toast',
        name: '常规提示',
        config: { message: '当前计数 {{ data.count }}', level: 'info' },
      },
    },

    connections: {
      // 页面级事件：来源用 'page' 哨兵，进页面就会把计数写成 2
      'on-page-load': {
        id: 'on-page-load',
        sourceNodeId: 'page',
        eventName: 'pageLoad',
        actionIds: ['set-count'],
        enabled: true,
      },
      'on-plus-click': {
        id: 'on-plus-click',
        sourceNodeId: 'plusButton',
        eventName: 'click',
        actionIds: ['increase', 'branch-threshold'],
        enabled: true,
      },
      'on-reset-click': {
        id: 'on-reset-click',
        sourceNodeId: 'resetButton',
        eventName: 'click',
        actionIds: ['reset-count', 'toast-normal'],
        enabled: true,
      },
    },

    metadata: { title: '事件链演示', description: '点击按钮驱动状态与提示' },
  }
}
