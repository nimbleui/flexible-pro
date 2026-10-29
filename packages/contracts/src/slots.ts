/**
 * 宿主插槽常量。
 *
 * 新增贡献点必须「先加契约常量，再加宿主插槽，再允许插件声明」：
 * 插件不允许自定义宿主不认识的 slot 字符串，插槽就是平台的产品边界。
 */
export const SLOT = {
  /** 设计器左侧面板（大纲、物料） */
  designerLeftPanel: 'designer.leftPanel',
  /** 设计器右侧面板（属性、AI） */
  designerRightPanel: 'designer.rightPanel',
  /** 设计器顶部工具栏 */
  designerToolbar: 'designer.toolbar',
  /** 设计器底部状态栏 */
  designerStatusBar: 'designer.statusBar',
} as const

/** 插槽名联合类型；由 SLOT 常量推导，禁止两处手写 */
export type SlotName = (typeof SLOT)[keyof typeof SLOT]
