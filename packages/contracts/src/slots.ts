/**
 * 宿主插槽常量。
 *
 * 新增贡献点必须「先加契约常量，再加宿主插槽，再允许插件声明」：
 * 插件不允许自定义宿主不认识的 slot 字符串，插槽就是平台的产品边界。
 */
export const SLOT = {
  /** 设计器左侧面板（物料） */
  designerLeftPanel: 'designer.leftPanel',
  /** 设计器右侧面板（属性、AI） */
  designerRightPanel: 'designer.rightPanel',
  /** 设计器顶部工具栏 */
  designerToolbar: 'designer.toolbar',
  /**
   * 设计器底部停靠面板（事件流、数据绑定、代码）
   *
   * 事件流是「页面/节点事件 → 动作序列」的编辑面，与左侧面板并列而不是它的一个页签：
   * 两者经常需要同时可见（左边选节点、下边配事件），互相挤占高度会让这个组合无法成立。
   */
  designerBottomPanel: 'designer.bottomPanel',
  /** 设计器底部状态栏 */
  designerStatusBar: 'designer.statusBar',
  /**
   * 设计器浮动面板（页面大纲）
   *
   * 覆盖在画布之上、可由外壳的入口开关，与左右常驻面板并列：
   * 大纲要在选节点时仍看得见画布上的那一下点击，挤进左栏会把物料面板顶下去，
   * 固定占一条右栏又和属性面板抢位置，所以给它一个可关掉的浮层槽。
   */
  designerOverlayPanel: 'designer.overlayPanel',
} as const

/** 插槽名联合类型；由 SLOT 常量推导，禁止两处手写 */
export type SlotName = (typeof SLOT)[keyof typeof SLOT]
