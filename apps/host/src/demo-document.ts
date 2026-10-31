import type { PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'

/**
 * 演示文档。
 *
 * 节点的 layout.rect 始终是世界坐标，容器按 children 递归渲染子树；
 * 层级顺序即 children 数组顺序，图层面板与层级命令改的就是它。
 * 文档里预置了一个分组、一个锁定节点和一个隐藏节点，用来直接演示图层树的能力。
 * 卡片与圆形内部再挂真实内容子节点，最深到 board → cards → cardB → cardBList → 文本，
 * 用来验证变换类手势作用在容器上时是否会连带它的整棵子树。
 */
export function createDemoSchema(): PageSchema {
  return {
    version: SCHEMA_VERSION,
    nodeId: 'board',
    nodes: {
      board: {
        id: 'board',
        componentName: 'Box',
        children: ['title', 'subtitle', 'cards', 'circle', 'badge', 'watermark', 'note'],
        layout: {
          mode: 'absolute',
          rect: { x: 80, y: 60, width: 820, height: 540 },
          zIndex: 0,
        },
        props: {
          fill: '#ffffff',
          stroke: 'rgba(15, 23, 42, 0.08)',
          radius: 18,
          label: '',
        },
        style: { boxShadow: '0 24px 60px rgba(15, 23, 42, 0.10)' },
      },
      title: {
        id: 'title',
        componentName: 'Text',
        layout: {
          mode: 'absolute',
          rect: { x: 120, y: 106, width: 520, height: 48 },
          zIndex: 2,
        },
        props: { text: '企业级低代码插件平台', fontSize: 26, weight: '700' },
      },
      subtitle: {
        id: 'subtitle',
        componentName: 'Text',
        layout: {
          mode: 'absolute',
          rect: { x: 120, y: 158, width: 620, height: 24 },
          zIndex: 2,
        },
        props: {
          text: '画布能力全部以插件装载：缩放 · 平移 · 选择 · 拖拽 · 缩放 · 吸附 · 辅助线 · 网格',
          fontSize: 13,
          color: '#64748b',
        },
      },
      cards: {
        id: 'cards',
        componentName: 'Group',
        name: '卡片组',
        children: ['cardA', 'cardB', 'draft'],
        layout: {
          mode: 'absolute',
          rect: { x: 120, y: 220, width: 472, height: 150 },
          zIndex: 3,
        },
      },
      cardA: {
        id: 'cardA',
        componentName: 'Box',
        children: ['cardATitle', 'cardAMetric', 'cardAChip'],
        layout: {
          mode: 'absolute',
          rect: { x: 120, y: 220, width: 220, height: 150 },
          zIndex: 3,
        },
        props: { fill: '#eef2ff', radius: 14, label: '' },
      },
      cardATitle: {
        id: 'cardATitle',
        componentName: 'Text',
        name: '卡片A标题',
        layout: {
          mode: 'absolute',
          rect: { x: 138, y: 236, width: 184, height: 26 },
          zIndex: 1,
        },
        props: { text: '插件贡献', fontSize: 14, weight: '600', color: '#1e293b' },
      },
      cardAMetric: {
        id: 'cardAMetric',
        componentName: 'Text',
        name: '卡片A描述',
        layout: {
          mode: 'absolute',
          rect: { x: 138, y: 266, width: 184, height: 42 },
          zIndex: 1,
        },
        props: {
          text: '16 个画布插件\n全部走贡献声明装载',
          fontSize: 12,
          weight: '400',
          color: '#475569',
        },
      },
      cardAChip: {
        id: 'cardAChip',
        componentName: 'Box',
        name: '卡片A徽标',
        children: ['cardAChipText'],
        layout: {
          mode: 'absolute',
          rect: { x: 138, y: 318, width: 96, height: 26 },
          zIndex: 1,
        },
        props: { fill: '#ffffff', stroke: 'rgba(37, 99, 235, 0.25)', radius: 13, label: '' },
      },
      cardAChipText: {
        id: 'cardAChipText',
        componentName: 'Text',
        name: '徽标文字',
        layout: {
          mode: 'absolute',
          rect: { x: 150, y: 322, width: 72, height: 18 },
          zIndex: 1,
        },
        props: { text: 'core', fontSize: 11, weight: '500', color: '#2563eb', align: 'center' },
      },
      cardB: {
        id: 'cardB',
        componentName: 'Box',
        children: ['cardBTitle', 'cardBList'],
        layout: {
          mode: 'absolute',
          rect: { x: 372, y: 220, width: 220, height: 150 },
          zIndex: 3,
        },
        props: { fill: '#ecfdf5', radius: 14, label: '' },
      },
      cardBTitle: {
        id: 'cardBTitle',
        componentName: 'Text',
        name: '卡片B标题',
        layout: {
          mode: 'absolute',
          rect: { x: 390, y: 236, width: 184, height: 26 },
          zIndex: 1,
        },
        props: { text: '画布事务', fontSize: 14, weight: '600', color: '#134e4a' },
      },
      cardBList: {
        id: 'cardBList',
        componentName: 'Box',
        name: '卡片B列表',
        children: ['cardBItemOne', 'cardBItemTwo'],
        layout: {
          mode: 'absolute',
          rect: { x: 390, y: 270, width: 184, height: 76 },
          zIndex: 1,
        },
        props: { fill: '#ffffff', stroke: 'rgba(15, 23, 42, 0.06)', radius: 10, label: '' },
      },
      cardBItemOne: {
        id: 'cardBItemOne',
        componentName: 'Text',
        name: '列表项1',
        layout: {
          mode: 'absolute',
          rect: { x: 402, y: 282, width: 160, height: 24 },
          zIndex: 1,
        },
        props: { text: '一次手势 · 一条历史', fontSize: 12, weight: '500', color: '#0f766e' },
      },
      cardBItemTwo: {
        id: 'cardBItemTwo',
        componentName: 'Text',
        name: '列表项2',
        layout: {
          mode: 'absolute',
          rect: { x: 402, y: 312, width: 160, height: 24 },
          zIndex: 1,
        },
        props: { text: '撤销 / 重做可回放', fontSize: 12, weight: '400', color: '#475569' },
      },
      draft: {
        id: 'draft',
        componentName: 'Text',
        name: '未定稿备注',
        hidden: true,
        layout: {
          mode: 'absolute',
          rect: { x: 120, y: 384, width: 220, height: 24 },
          zIndex: 3,
        },
        props: { text: '默认隐藏的节点，图层面板里点亮眼睛即可显示', fontSize: 12 },
      },
      circle: {
        id: 'circle',
        componentName: 'Circle',
        children: ['circleLabel', 'circleOverflow'],
        layout: {
          mode: 'absolute',
          rect: { x: 636, y: 228, width: 140, height: 140 },
          zIndex: 3,
        },
        props: { fill: '#fef3c7' },
      },
      circleLabel: {
        id: 'circleLabel',
        componentName: 'Text',
        name: '圆内文字',
        layout: {
          mode: 'absolute',
          rect: { x: 656, y: 286, width: 100, height: 24 },
          zIndex: 4,
        },
        props: { text: '吸附', fontSize: 13, weight: '600', color: '#92400e', align: 'center' },
      },
      circleOverflow: {
        id: 'circleOverflow',
        componentName: 'Box',
        name: '越界子节点',
        layout: {
          mode: 'absolute',
          rect: { x: 700, y: 330, width: 120, height: 30 },
          zIndex: 5,
        },
        props: {
          fill: '#fee2e2',
          stroke: 'rgba(220, 38, 38, 0.3)',
          radius: 8,
          label: '超出父级',
        },
      },
      badge: {
        id: 'badge',
        componentName: 'Text',
        condition: { type: 'expression', raw: "page.title !== ''" },
        layout: {
          mode: 'absolute',
          rect: { x: 636, y: 384, width: 180, height: 40 },
          zIndex: 3,
        },
        props: {
          text: '{{ page.title }} · 插件驱动',
          fontSize: 12,
          color: '#2563eb',
        },
      },
      watermark: {
        id: 'watermark',
        componentName: 'Text',
        name: '锁定角标',
        locked: true,
        layout: {
          mode: 'absolute',
          rect: { x: 700, y: 110, width: 160, height: 24 },
          zIndex: 4,
        },
        props: { text: '锁定：画布上点不到', fontSize: 12, color: '#94a3b8', align: 'right' },
      },
      note: {
        id: 'note',
        componentName: 'Text',
        layout: {
          mode: 'absolute',
          rect: { x: 120, y: 430, width: 700, height: 60 },
          zIndex: 3,
        },
        props: {
          text:
            '两张卡片与圆形内部都带子级（最深四层，右侧还有一个越出父级边界的子节点）：容器变换应整棵子树一起动。' +
            '拖拽物料到画布即可新增节点；Delete 删除、Ctrl/⌘+C/V/D 复制粘贴再制、方向键微调、⌘K 打开命令面板。' +
            '图层面板支持点选、双击改名、眼睛与锁开关、同父拖拽排序；⌘G 组合、⌘⇧G 解组、⌘[ / ⌘] 调层级、⌘⇧H 隐藏、⌘⇧L 锁定。',
          fontSize: 13,
          color: '#475569',
        },
      },
    },
    components: [],
    metadata: { title: '示例页面', description: '插件化低代码设计器演示文档' },
  }
}
