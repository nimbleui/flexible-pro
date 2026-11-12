import type { FlowDefinition, FlowEdge, FlowNode } from '@lc/schema'
import {
  APPROVAL_SUBMIT,
  DEFAULT_FLOW_SETTINGS,
  FLOW_CONDITION,
  FLOW_END,
  FLOW_PARALLEL,
  FLOW_TRIGGER,
  LOG_RECORD,
  STATE_GET,
  createExpression,
} from '@lc/schema'

/**
 * 内置示例流程。
 *
 * 第一次打开（IndexedDB 里没有数据）时落这张图，作用有两个：让「流程编排管理」
 * 不是一页空白，以及把参考图里的审批链路当成一份**可执行**的样例——图上每个节点
 * 都能在试运行里真的跑一遍，而不是画给人看的示意图。
 *
 * id 固定而不是随机生成：事件绑定引用的是流程 id，示例图需要一个可预期的键。
 */
export function createSeedFlow(): FlowDefinition {
  const nodes: FlowNode[] = [
    {
      id: 'trigger',
      type: FLOW_TRIGGER,
      name: '开始',
      description: '页面点击触发',
      position: { x: 470, y: 40 },
      // 只声明来源类型。绑哪个页面的哪个按钮写在页面那一侧（`admin-doc` 的
      // `on-filter-all` 连接把这张图选成了「执行流程图」），图里不留影子绑定。
      config: { kind: 'pageEvent' },
    },
    {
      id: 'fetch',
      type: STATE_GET,
      name: '获取表单数据',
      description: '读取表单字段',
      position: { x: 470, y: 152 },
      config: { key: 'formData', assignTo: 'order' },
    },
    {
      id: 'condition',
      type: FLOW_CONDITION,
      name: '是否需要审批?',
      description: '按订单金额分流',
      position: { x: 460, y: 264 },
      config: { expression: createExpression('{{ order.amount > 1000 }}') },
    },
    {
      id: 'submit',
      type: APPROVAL_SUBMIT,
      name: '提交审批',
      description: '调用审批服务发起审批',
      position: { x: 250, y: 404 },
      config: {
        template: '订单审批模板',
        assignee: '张三',
        mode: 'any',
        timeoutHours: 24,
      },
      inputMapping: {
        orderId: '{{ data.orderId }}',
        amount: '{{ data.amount }}',
      },
      outputMapping: {
        result: '{{ result }}',
      },
    },
    {
      id: 'pass',
      type: 'state.set',
      name: '直接通过',
      description: '设置状态为通过',
      position: { x: 660, y: 404 },
      config: { key: 'orderStatus', value: '已通过' },
    },
    {
      id: 'parallel',
      type: FLOW_PARALLEL,
      name: '并行执行',
      description: '发送通知 + 记录日志',
      position: { x: 250, y: 524 },
      config: {},
    },
    {
      id: 'notify',
      type: 'ui.toast',
      name: '发送通知',
      description: '提示订单已进入审批',
      position: { x: 120, y: 644 },
      config: { message: '订单已进入审批流程', level: 'info' },
    },
    {
      id: 'log',
      type: LOG_RECORD,
      name: '记录日志',
      description: '写入审批记录',
      position: { x: 380, y: 644 },
      config: { message: '审批记录已写入', level: 'info' },
    },
    {
      id: 'update',
      type: 'state.set',
      name: '更新订单状态',
      description: '更新订单为已处理',
      position: { x: 250, y: 764 },
      config: { key: 'orderStatus', value: '已处理' },
    },
    {
      id: 'end',
      type: FLOW_END,
      name: '结束',
      description: '流程执行完毕',
      position: { x: 470, y: 884 },
      config: {},
    },
  ]

  const edges: FlowEdge[] = [
    { id: 'edge-1', source: 'trigger', target: 'fetch' },
    { id: 'edge-2', source: 'fetch', target: 'condition' },
    { id: 'edge-3', source: 'condition', target: 'submit', branch: 'true', label: '是' },
    { id: 'edge-4', source: 'condition', target: 'pass', branch: 'false', label: '否' },
    { id: 'edge-5', source: 'submit', target: 'parallel' },
    { id: 'edge-6', source: 'parallel', target: 'notify' },
    { id: 'edge-7', source: 'parallel', target: 'log' },
    { id: 'edge-8', source: 'notify', target: 'update' },
    { id: 'edge-9', source: 'log', target: 'update' },
    { id: 'edge-10', source: 'update', target: 'end' },
    { id: 'edge-11', source: 'pass', target: 'end' },
  ]

  return {
    id: 'flow-order-approval',
    name: '订单审批流程',
    description: '用户提交订单后，自动触发审批流程',
    status: 'published',
    version: '1.0.0',
    updatedAt: '2026-10-26T16:30:00.000Z',
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    edges: Object.fromEntries(edges.map((edge) => [edge.id, edge])),
    settings: { ...DEFAULT_FLOW_SETTINGS },
  }
}
