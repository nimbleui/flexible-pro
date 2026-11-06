import type { PageSchema } from '@lc/schema'
import { SCHEMA_VERSION, createExpression } from '@lc/schema'

/**
 * 工单管理系统示例文档。
 *
 * 一张典型管理后台：左侧导航、顶部统计卡、筛选条、工单列表、底部动作按钮。
 * 画面本身只是载体，重点是**每条链都能在预览页上验证**，按触发路径分工：
 *
 * - `page → pageLoad` 取数并把筛选切成「全部」，列表立刻从 1 行变 3 行；
 * - `page → pageUnload` 演示第二个页面级事件；
 * - 筛选按钮写 `data.filter`，行节点用 `condition` 表达「命中才渲染」，
 *   同一批按钮的 `disabled` 又读回同一个变量，形成「点了就变」的闭环；
 * - 刷新按钮走 `state.set → dataSource.fetch → flow.condition`，成立分支指向
 *   `flow.sequence`，用来演示分支里的多动作复用；
 * - 「批量关单」在无余量时用 `flow.end` 掐断整条链，后续审计提示不再执行——
 *   那条审计提示同时带了动作级 `condition`，量小时会被记为 skipped；
 * - 「模拟异常」故意写入未声明变量，靠 `onError: 'fallback'` 转去补救动作，
 *   链子继续跑完，演示失败策略而不是只演顺利路径。
 *
 * 与事件链演示页同样的取舍：只用基础物料与内置动作，不引入外部组件库，
 * 任何一段跑不动都能沿「事件是否 emit → 连接是否匹配 → 动作是否执行 → 状态是否回流」定位。
 */
export function createAdminDocumentSchema(): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'console',

    nodes: {
      console: {
        id: 'console',
        componentName: 'Box',
        name: '管理台画幅',
        children: [
          'sideNav',
          'sideFilter',
          'sideFoot',
          'title',
          'subtitle',
          'cardTotal',
          'cardPending',
          'cardDone',
          'btnAll',
          'btnPending',
          'rowPending',
          'rowStale',
          'rowDone',
          'hint',
          'btnRefresh',
          'btnClose',
          'btnFault',
          'btnReset',
          'btnGoto',
        ],
        layout: {
          mode: 'absolute',
          rect: { x: 60, y: 40, width: 1040, height: 640 },
          zIndex: 0,
        },
        props: { fill: '#ffffff', stroke: 'rgba(15, 23, 42, 0.08)', radius: 18, label: '' },
        style: { boxShadow: '0 24px 60px rgba(15, 23, 42, 0.10)' },
      },

      sideNav: {
        id: 'sideNav',
        componentName: 'Box',
        name: '侧边导航',
        children: ['navOverview', 'navTickets', 'navMembers', 'navSettings'],
        layout: {
          mode: 'absolute',
          rect: { x: 60, y: 40, width: 200, height: 640 },
          zIndex: 1,
        },
        props: {
          fill: '#f1f5f9',
          stroke: 'rgba(15, 23, 42, 0.06)',
          radius: 18,
          label: '',
        },
      },
      navOverview: {
        id: 'navOverview',
        componentName: 'Text',
        name: '导航·概览',
        layout: { mode: 'absolute', rect: { x: 84, y: 96, width: 152, height: 28 }, zIndex: 2 },
        props: { text: '概览', fontSize: 14, color: '#64748b' },
      },
      navTickets: {
        id: 'navTickets',
        componentName: 'Text',
        name: '导航·工单列表',
        layout: {
          mode: 'absolute',
          rect: { x: 84, y: 130, width: 152, height: 28 },
          zIndex: 2,
        },
        props: { text: '工单列表', fontSize: 14, weight: '600', color: '#0f172a' },
      },
      navMembers: {
        id: 'navMembers',
        componentName: 'Text',
        name: '导航·成员与权限',
        layout: {
          mode: 'absolute',
          rect: { x: 84, y: 164, width: 152, height: 28 },
          zIndex: 2,
        },
        props: { text: '成员与权限', fontSize: 14, color: '#64748b' },
      },
      navSettings: {
        id: 'navSettings',
        componentName: 'Text',
        name: '导航·系统设置',
        layout: {
          mode: 'absolute',
          rect: { x: 84, y: 198, width: 152, height: 28 },
          zIndex: 2,
        },
        props: { text: '系统设置', fontSize: 14, color: '#64748b' },
      },
      sideFilter: {
        id: 'sideFilter',
        componentName: 'Text',
        name: '当前筛选',
        layout: {
          mode: 'absolute',
          rect: { x: 84, y: 600, width: 152, height: 28 },
          zIndex: 2,
        },
        props: {
          text: '筛选：{{ data.filter === "all" ? "全部工单" : "仅待处理" }}',
          fontSize: 12,
          weight: '600',
          color: '#2563eb',
        },
      },
      sideFoot: {
        id: 'sideFoot',
        componentName: 'Text',
        name: '侧栏脚注',
        layout: {
          mode: 'absolute',
          rect: { x: 84, y: 630, width: 152, height: 32 },
          zIndex: 2,
        },
        props: { text: 'mock 数据源 · 事件链驱动', fontSize: 11, color: '#94a3b8' },
      },

      title: {
        id: 'title',
        componentName: 'Text',
        name: '页面标题',
        layout: {
          mode: 'absolute',
          rect: { x: 296, y: 80, width: 520, height: 36 },
          zIndex: 2,
        },
        props: { text: '工单管理系统', fontSize: 24, weight: '700', color: '#0f172a' },
      },
      subtitle: {
        id: 'subtitle',
        componentName: 'Text',
        name: '统计副标题',
        layout: {
          mode: 'absolute',
          rect: { x: 296, y: 120, width: 640, height: 24 },
          zIndex: 2,
        },
        props: {
          text: '共 {{ data.tickets.data.total }} 张工单 · 本次已刷新 {{ data.refreshCount }} 次',
          fontSize: 13,
          color: '#64748b',
        },
      },

      cardTotal: {
        id: 'cardTotal',
        componentName: 'Box',
        name: '指标卡·总量',
        children: ['cardTotalLabel', 'cardTotalValue'],
        layout: {
          mode: 'absolute',
          rect: { x: 296, y: 164, width: 224, height: 96 },
          zIndex: 2,
        },
        props: { fill: '#eef2ff', stroke: 'rgba(37, 99, 235, 0.16)', radius: 14, label: '' },
      },
      cardTotalLabel: {
        id: 'cardTotalLabel',
        componentName: 'Text',
        name: '指标名·总量',
        layout: {
          mode: 'absolute',
          rect: { x: 316, y: 180, width: 184, height: 22 },
          zIndex: 3,
        },
        props: { text: '工单总量', fontSize: 12, color: '#475569' },
      },
      cardTotalValue: {
        id: 'cardTotalValue',
        componentName: 'Text',
        name: '指标值·总量',
        layout: {
          mode: 'absolute',
          rect: { x: 316, y: 206, width: 184, height: 38 },
          zIndex: 3,
        },
        props: {
          text: '{{ data.tickets.data.total }}',
          fontSize: 26,
          weight: '700',
          color: '#1e293b',
        },
      },
      cardPending: {
        id: 'cardPending',
        componentName: 'Box',
        name: '指标卡·待处理',
        children: ['cardPendingLabel', 'cardPendingValue'],
        layout: {
          mode: 'absolute',
          rect: { x: 536, y: 164, width: 224, height: 96 },
          zIndex: 2,
        },
        props: { fill: '#fff7ed', stroke: 'rgba(180, 83, 9, 0.18)', radius: 14, label: '' },
      },
      cardPendingLabel: {
        id: 'cardPendingLabel',
        componentName: 'Text',
        name: '指标名·待处理',
        layout: {
          mode: 'absolute',
          rect: { x: 556, y: 180, width: 184, height: 22 },
          zIndex: 3,
        },
        props: { text: '待处理', fontSize: 12, color: '#9a3412' },
      },
      cardPendingValue: {
        id: 'cardPendingValue',
        componentName: 'Text',
        name: '指标值·待处理',
        layout: {
          mode: 'absolute',
          rect: { x: 556, y: 206, width: 184, height: 38 },
          zIndex: 3,
        },
        props: {
          text: '{{ data.tickets.data.pending - data.closedCount }}',
          fontSize: 26,
          weight: '700',
          color: '#b45309',
        },
      },
      cardDone: {
        id: 'cardDone',
        componentName: 'Box',
        name: '指标卡·已完成',
        children: ['cardDoneLabel', 'cardDoneValue'],
        layout: {
          mode: 'absolute',
          rect: { x: 776, y: 164, width: 224, height: 96 },
          zIndex: 2,
        },
        props: { fill: '#ecfdf5', stroke: 'rgba(4, 120, 87, 0.18)', radius: 14, label: '' },
      },
      cardDoneLabel: {
        id: 'cardDoneLabel',
        componentName: 'Text',
        name: '指标名·已完成',
        layout: {
          mode: 'absolute',
          rect: { x: 796, y: 180, width: 184, height: 22 },
          zIndex: 3,
        },
        props: { text: '已完成', fontSize: 12, color: '#065f46' },
      },
      cardDoneValue: {
        id: 'cardDoneValue',
        componentName: 'Text',
        name: '指标值·已完成',
        layout: {
          mode: 'absolute',
          rect: { x: 796, y: 206, width: 184, height: 38 },
          zIndex: 3,
        },
        props: {
          text: '{{ data.tickets.data.done + data.closedCount }}',
          fontSize: 26,
          weight: '700',
          color: '#047857',
        },
      },

      btnAll: {
        id: 'btnAll',
        componentName: 'Button',
        name: '筛选·全部工单',
        layout: {
          mode: 'absolute',
          rect: { x: 296, y: 280, width: 120, height: 36 },
          zIndex: 3,
        },
        props: {
          label: '全部工单',
          tone: 'primary',
          // 已经是当前视图就禁用：按钮态读回同一个变量，省掉「点了没变化」的困惑
          disabled: createExpression('{{ data.filter === "all" }}'),
        },
      },
      btnPending: {
        id: 'btnPending',
        componentName: 'Button',
        name: '筛选·仅待处理',
        layout: {
          mode: 'absolute',
          rect: { x: 428, y: 280, width: 120, height: 36 },
          zIndex: 3,
        },
        props: {
          label: '仅待处理',
          tone: 'neutral',
          disabled: createExpression('{{ data.filter === "pending" }}'),
        },
      },

      rowPending: {
        id: 'rowPending',
        componentName: 'Box',
        name: '工单行·登录白屏',
        children: ['rowPendingTitle', 'rowPendingMeta', 'rowPendingState'],
        condition: createExpression(
          '{{ data.filter === "all" || data.filter === data.tickets.data.rows[0].status }}',
        ),
        layout: {
          mode: 'absolute',
          rect: { x: 296, y: 332, width: 704, height: 56 },
          zIndex: 2,
        },
        props: { fill: '#ffffff', stroke: 'rgba(15, 23, 42, 0.08)', radius: 10, label: '' },
      },
      rowPendingTitle: {
        id: 'rowPendingTitle',
        componentName: 'Text',
        name: '工单标题1',
        layout: {
          mode: 'absolute',
          rect: { x: 316, y: 342, width: 380, height: 22 },
          zIndex: 3,
        },
        props: {
          text: '{{ data.tickets.data.rows[0].title }}',
          fontSize: 13,
          weight: '600',
          color: '#0f172a',
        },
      },
      rowPendingMeta: {
        id: 'rowPendingMeta',
        componentName: 'Text',
        name: '工单元信息1',
        layout: {
          mode: 'absolute',
          rect: { x: 316, y: 366, width: 380, height: 20 },
          zIndex: 3,
        },
        props: {
          text: '{{ data.tickets.data.rows[0].id }} · 负责人 {{ data.tickets.data.rows[0].owner }}',
          fontSize: 12,
          color: '#64748b',
        },
      },
      rowPendingState: {
        id: 'rowPendingState',
        componentName: 'Text',
        name: '工单状态1',
        layout: {
          mode: 'absolute',
          rect: { x: 716, y: 350, width: 160, height: 22 },
          zIndex: 3,
        },
        props: {
          text: '{{ data.tickets.data.rows[0].status === "pending" ? "待处理" : "已完成" }}',
          fontSize: 12,
          weight: '500',
          color: '#b45309',
          align: 'right',
        },
      },

      rowStale: {
        id: 'rowStale',
        componentName: 'Box',
        name: '工单行·导出超时',
        children: ['rowStaleTitle', 'rowStaleMeta', 'rowStaleState'],
        condition: createExpression(
          '{{ data.filter === "all" || data.filter === data.tickets.data.rows[1].status }}',
        ),
        layout: {
          mode: 'absolute',
          rect: { x: 296, y: 396, width: 704, height: 56 },
          zIndex: 2,
        },
        props: { fill: '#ffffff', stroke: 'rgba(15, 23, 42, 0.08)', radius: 10, label: '' },
      },
      rowStaleTitle: {
        id: 'rowStaleTitle',
        componentName: 'Text',
        name: '工单标题2',
        layout: {
          mode: 'absolute',
          rect: { x: 316, y: 406, width: 380, height: 22 },
          zIndex: 3,
        },
        props: {
          text: '{{ data.tickets.data.rows[1].title }}',
          fontSize: 13,
          weight: '600',
          color: '#0f172a',
        },
      },
      rowStaleMeta: {
        id: 'rowStaleMeta',
        componentName: 'Text',
        name: '工单元信息2',
        layout: {
          mode: 'absolute',
          rect: { x: 316, y: 430, width: 380, height: 20 },
          zIndex: 3,
        },
        props: {
          text: '{{ data.tickets.data.rows[1].id }} · 负责人 {{ data.tickets.data.rows[1].owner }}',
          fontSize: 12,
          color: '#64748b',
        },
      },
      rowStaleState: {
        id: 'rowStaleState',
        componentName: 'Text',
        name: '工单状态2',
        layout: {
          mode: 'absolute',
          rect: { x: 716, y: 414, width: 160, height: 22 },
          zIndex: 3,
        },
        props: {
          text: '{{ data.tickets.data.rows[1].status === "pending" ? "待处理" : "已完成" }}',
          fontSize: 12,
          weight: '500',
          color: '#b45309',
          align: 'right',
        },
      },

      rowDone: {
        id: 'rowDone',
        componentName: 'Box',
        name: '工单行·权限同步',
        children: ['rowDoneTitle', 'rowDoneMeta', 'rowDoneState'],
        condition: createExpression(
          '{{ data.filter === "all" || data.filter === data.tickets.data.rows[2].status }}',
        ),
        layout: {
          mode: 'absolute',
          rect: { x: 296, y: 460, width: 704, height: 56 },
          zIndex: 2,
        },
        props: { fill: '#ffffff', stroke: 'rgba(15, 23, 42, 0.08)', radius: 10, label: '' },
      },
      rowDoneTitle: {
        id: 'rowDoneTitle',
        componentName: 'Text',
        name: '工单标题3',
        layout: {
          mode: 'absolute',
          rect: { x: 316, y: 470, width: 380, height: 22 },
          zIndex: 3,
        },
        props: {
          text: '{{ data.tickets.data.rows[2].title }}',
          fontSize: 13,
          weight: '600',
          color: '#0f172a',
        },
      },
      rowDoneMeta: {
        id: 'rowDoneMeta',
        componentName: 'Text',
        name: '工单元信息3',
        layout: {
          mode: 'absolute',
          rect: { x: 316, y: 494, width: 380, height: 20 },
          zIndex: 3,
        },
        props: {
          text: '{{ data.tickets.data.rows[2].id }} · 负责人 {{ data.tickets.data.rows[2].owner }}',
          fontSize: 12,
          color: '#64748b',
        },
      },
      rowDoneState: {
        id: 'rowDoneState',
        componentName: 'Text',
        name: '工单状态3',
        layout: {
          mode: 'absolute',
          rect: { x: 716, y: 478, width: 160, height: 22 },
          zIndex: 3,
        },
        props: {
          text: '{{ data.tickets.data.rows[2].status === "pending" ? "待处理" : "已完成" }}',
          fontSize: 12,
          weight: '500',
          color: '#047857',
          align: 'right',
        },
      },

      hint: {
        id: 'hint',
        componentName: 'Text',
        name: '用法提示',
        layout: {
          mode: 'absolute',
          rect: { x: 296, y: 528, width: 704, height: 28 },
          zIndex: 2,
        },
        props: {
          text: '「批量关单」在无余量时用 flow.end 掐断整条链，后续审计提示不再执行；「模拟异常」故意写入未声明变量，靠 onError 的 fallback 转去补救动作。',
          fontSize: 12,
          color: '#475569',
        },
      },

      btnRefresh: {
        id: 'btnRefresh',
        componentName: 'Button',
        name: '刷新数据按钮',
        layout: {
          mode: 'absolute',
          rect: { x: 296, y: 572, width: 120, height: 36 },
          zIndex: 3,
        },
        props: { label: '刷新数据', tone: 'primary' },
      },
      btnClose: {
        id: 'btnClose',
        componentName: 'Button',
        name: '批量关单按钮',
        layout: {
          mode: 'absolute',
          rect: { x: 428, y: 572, width: 120, height: 36 },
          zIndex: 3,
        },
        props: { label: '批量关单', tone: 'neutral' },
      },
      btnFault: {
        id: 'btnFault',
        componentName: 'Button',
        name: '模拟异常按钮',
        layout: {
          mode: 'absolute',
          rect: { x: 560, y: 572, width: 120, height: 36 },
          zIndex: 3,
        },
        props: { label: '模拟异常', tone: 'danger' },
      },
      btnReset: {
        id: 'btnReset',
        componentName: 'Button',
        name: '重置按钮',
        layout: {
          mode: 'absolute',
          rect: { x: 692, y: 572, width: 100, height: 36 },
          zIndex: 3,
        },
        props: { label: '重置', tone: 'neutral' },
      },
      btnGoto: {
        id: 'btnGoto',
        componentName: 'Button',
        name: '跳转按钮',
        layout: {
          mode: 'absolute',
          rect: { x: 804, y: 572, width: 160, height: 36 },
          zIndex: 3,
        },
        props: { label: '打开事件链演示', tone: 'neutral' },
      },
    },

    components: [],

    datasources: [
      {
        id: 'tickets',
        type: 'mock',
        description:
          '工单列表：内置 mock 数据，接服务端时把 type 换成 rest 即可，表达式口径不变',
        config: {
          kind: 'mock',
          delay: 120,
          data: {
            total: 24,
            pending: 3,
            done: 21,
            rows: [
              { id: 'T-1024', title: '登录页偶发白屏', owner: '陈屿', status: 'pending' },
              { id: 'T-1023', title: '报表导出超过网关时限', owner: '林墨', status: 'pending' },
              { id: 'T-1022', title: '权限组同步失败已修复', owner: '赵岚', status: 'done' },
            ],
          },
        },
      },
    ],

    variables: [
      {
        name: 'filter',
        type: { kind: 'string' },
        defaultValue: 'pending',
        description: '列表筛选：all 全部 / pending 待处理',
      },
      {
        name: 'refreshCount',
        type: { kind: 'number' },
        defaultValue: 0,
        description: '刷新次数',
      },
      {
        name: 'closedCount',
        type: { kind: 'number' },
        defaultValue: 0,
        description: '本次会话已关闭的工单数',
      },
    ],

    actions: {
      'load-tickets': {
        id: 'load-tickets',
        type: 'dataSource.fetch',
        name: '拉取工单数据源',
        config: { dataSourceId: 'tickets' },
      },
      'set-filter-all': {
        id: 'set-filter-all',
        type: 'state.set',
        name: '筛选切到全部',
        // 普通字符串而不是表达式对象：这里要写死常量，包一层 {{ }} 反而会被当成插值
        config: { key: 'filter', value: 'all' },
      },
      'set-filter-pending': {
        id: 'set-filter-pending',
        type: 'state.set',
        name: '筛选切到待处理',
        config: { key: 'filter', value: 'pending' },
      },
      'toast-filter': {
        id: 'toast-filter',
        type: 'ui.toast',
        name: '播报当前筛选',
        // 同一条提示被两条筛选连接复用：变量的最新值由每步重建的作用域带回，不必写两条文案
        config: {
          message: '已切换到{{ data.filter === "all" ? "全部工单" : "仅待处理" }}',
          level: 'info',
        },
      },
      'toast-ready': {
        id: 'toast-ready',
        type: 'ui.toast',
        name: '数据就绪提示',
        config: {
          message: '工单数据已就绪，共 {{ data.tickets.data.total }} 张',
          level: 'success',
        },
      },
      'count-refresh': {
        id: 'count-refresh',
        type: 'state.set',
        name: '刷新次数加一',
        config: { key: 'refreshCount', value: createExpression('{{ data.refreshCount + 1 }}') },
      },
      'branch-refresh-hint': {
        id: 'branch-refresh-hint',
        type: 'flow.condition',
        name: '刷新偏多时分派',
        config: {
          expression: createExpression('{{ data.refreshCount >= 3 }}'),
          trueActionId: 'seq-refresh-hint',
          falseActionId: 'toast-refreshed',
        },
      },
      'seq-refresh-hint': {
        id: 'seq-refresh-hint',
        type: 'flow.sequence',
        name: '刷新提示 + 缓存建议',
        config: { actionIds: ['toast-refreshed', 'toast-refresh-advice'] },
      },
      'toast-refreshed': {
        id: 'toast-refreshed',
        type: 'ui.toast',
        name: '刷新完成',
        config: { message: '第 {{ data.refreshCount }} 次刷新完成', level: 'info' },
      },
      'toast-refresh-advice': {
        id: 'toast-refresh-advice',
        type: 'ui.toast',
        name: '缓存建议',
        config: {
          message: '刷新次数已不少于 3 次，真实项目建议给数据源加缓存',
          level: 'warning',
        },
      },
      'branch-pending-left': {
        id: 'branch-pending-left',
        type: 'flow.condition',
        name: '判定还有无待处理',
        config: {
          expression: createExpression(
            '{{ data.tickets.data.pending - data.closedCount > 0 }}',
          ),
          trueActionId: 'seq-close-one',
          falseActionId: 'seq-all-closed',
        },
      },
      'seq-close-one': {
        id: 'seq-close-one',
        type: 'flow.sequence',
        name: '关一张并播报',
        config: { actionIds: ['close-one', 'toast-closed-one'] },
      },
      'close-one': {
        id: 'close-one',
        type: 'state.set',
        name: '已关单数加一',
        config: { key: 'closedCount', value: createExpression('{{ data.closedCount + 1 }}') },
      },
      'toast-closed-one': {
        id: 'toast-closed-one',
        type: 'ui.toast',
        name: '关单成功',
        config: { message: '已关闭 1 张，累计 {{ data.closedCount }} 张', level: 'success' },
      },
      'seq-all-closed': {
        id: 'seq-all-closed',
        type: 'flow.sequence',
        name: '提示结束并终止链',
        // 序列里的 flow.end 会向上传递 stop，包含它的整条链一起停下
        config: { actionIds: ['toast-no-task', 'stop-close-chain'] },
      },
      'toast-no-task': {
        id: 'toast-no-task',
        type: 'ui.toast',
        name: '无待处理提示',
        config: { message: '已无待处理工单，批量关单到此结束', level: 'info' },
      },
      'stop-close-chain': {
        id: 'stop-close-chain',
        type: 'flow.end',
        name: '结束关单事件流',
        config: {},
      },
      'toast-close-audit': {
        id: 'toast-close-audit',
        type: 'ui.toast',
        name: '关单审计播报',
        // 动作级 condition：条件为假时本步记为 skipped 并继续走链，与 flow.condition 的分支选择是两件事
        condition: createExpression('{{ data.closedCount > 1 }}'),
        config: { message: '审计：本会话已关闭 {{ data.closedCount }} 张', level: 'info' },
      },
      'fault-undeclared': {
        id: 'fault-undeclared',
        type: 'state.set',
        name: '故意写入未声明变量',
        // `syncToken` 刻意不在 variables 里：状态处理器会拒绝未声明的名字并抛错，
        // 用来在预览页上真实走一遍 onError 的失败处置，而不是只用文案描述它
        config: { key: 'syncToken', value: 'demo' },
        onError: 'fallback',
        fallbackActionId: 'toast-fallback',
      },
      'toast-fallback': {
        id: 'toast-fallback',
        type: 'ui.toast',
        name: '补救分支提示',
        config: { message: '写入失败已命中 fallback 补救动作', level: 'warning' },
      },
      'toast-fallback-kept': {
        id: 'toast-fallback-kept',
        type: 'ui.toast',
        name: '链未中断播报',
        config: { message: '补救完成后链继续执行到本步', level: 'info' },
      },
      'reset-demo': {
        id: 'reset-demo',
        type: 'state.reset',
        name: '重置全部变量',
        // key 留空即重置全部，是表单里写明的语义
        config: {},
      },
      'toast-reset': {
        id: 'toast-reset',
        type: 'ui.toast',
        name: '重置完成',
        config: { message: '状态已回到声明的默认值', level: 'success' },
      },
      'toast-leave': {
        id: 'toast-leave',
        type: 'ui.toast',
        name: '离开前提示',
        config: { message: '即将跳转到事件链演示', level: 'info' },
      },
      'goto-event-doc': {
        id: 'goto-event-doc',
        type: 'navigation.go',
        name: '跳转事件链演示',
        config: { to: '/preview/event-doc' },
      },
      'toast-unload': {
        id: 'toast-unload',
        type: 'ui.toast',
        name: '卸载播报',
        // 卸载链跑在运行时释放订阅之前，此时仍可读状态；失败不该挡住离开，故 continue
        onError: 'continue',
        config: { message: '工单管理系统已卸载', level: 'info' },
      },
    },

    connections: {
      // 页面级事件：进页面即取数，并把筛选从默认的 pending 切成 all，列表当场从 1 行变 3 行
      'on-page-load': {
        id: 'on-page-load',
        sourceNodeId: 'page',
        eventName: 'pageLoad',
        actionIds: ['load-tickets', 'set-filter-all', 'toast-ready'],
        enabled: true,
      },
      'on-page-unload': {
        id: 'on-page-unload',
        sourceNodeId: 'page',
        eventName: 'pageUnload',
        actionIds: ['toast-unload'],
        enabled: true,
      },
      'on-filter-all': {
        id: 'on-filter-all',
        sourceNodeId: 'btnAll',
        eventName: 'click',
        actionIds: ['set-filter-all', 'toast-filter'],
        // 内置示例流程：链跑完之后接着跑图，两条都执行。
        // 注意这张图目前会停在第 2 步「读取变量」——`state.get` 还没有生产处理器，
        // 见 `flow-handlers.ts` 的注册表；绑定本身是通的，运行调试里能看到它跑到哪一步。
        flowId: 'flow-order-approval',
        enabled: true,
      },
      'on-filter-pending': {
        id: 'on-filter-pending',
        sourceNodeId: 'btnPending',
        eventName: 'click',
        actionIds: ['set-filter-pending', 'toast-filter'],
        enabled: true,
      },
      'on-refresh': {
        id: 'on-refresh',
        sourceNodeId: 'btnRefresh',
        eventName: 'click',
        actionIds: ['count-refresh', 'load-tickets', 'branch-refresh-hint'],
        enabled: true,
      },
      'on-close': {
        id: 'on-close',
        sourceNodeId: 'btnClose',
        eventName: 'click',
        // 末项只在「还有余量」时执行：走 flow.end 分支时它不会被跑到
        actionIds: ['branch-pending-left', 'toast-close-audit'],
        enabled: true,
      },
      'on-fault': {
        id: 'on-fault',
        sourceNodeId: 'btnFault',
        eventName: 'click',
        actionIds: ['fault-undeclared', 'toast-fallback-kept'],
        enabled: true,
      },
      'on-reset': {
        id: 'on-reset',
        sourceNodeId: 'btnReset',
        eventName: 'click',
        actionIds: ['reset-demo', 'toast-reset'],
        enabled: true,
      },
      'on-goto': {
        id: 'on-goto',
        sourceNodeId: 'btnGoto',
        eventName: 'click',
        actionIds: ['toast-leave', 'goto-event-doc'],
        enabled: true,
      },
    },

    metadata: {
      title: '工单管理系统',
      description: '管理系统示例页：mock 数据源 + 事件链驱动筛选、关单、异常兜底与重置',
    },
  }
}
