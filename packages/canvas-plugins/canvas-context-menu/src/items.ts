import type { CanvasMenuItem } from '@lc/contracts'
import type { SelectionService } from '@lc/contracts'

/**
 * 设计器自带的右键菜单项。
 *
 * 只声明「哪个命令出现在哪个位置、什么时候可见」，可用性与执行结果一律回到命令
 * 注册表：命令被置灰这里就置灰，命令插件没装配（画布预设里没有该能力）时菜单项
 * 直接不出现，菜单因此不会列出点了没反应的项目。
 */
export function createMenuItems(selection: SelectionService): CanvasMenuItem[] {
  /** 右键命中节点时已经先把选中集收敛到它，所以「有选中」等价于「操作对象存在」 */
  const hasSelection = (): boolean => selection.ids.length > 0

  return [
    {
      id: 'menu.copy',
      command: 'canvas.copySelection',
      group: 'edit',
      order: 10,
      visible: hasSelection,
    },
    { id: 'menu.paste', command: 'canvas.pasteSelection', group: 'edit', order: 11 },
    {
      id: 'menu.duplicate',
      command: 'canvas.duplicateSelection',
      group: 'edit',
      order: 12,
      visible: hasSelection,
    },
    {
      id: 'menu.delete',
      command: 'canvas.deleteSelection',
      group: 'edit',
      order: 13,
      visible: hasSelection,
    },
    {
      id: 'menu.group',
      command: 'canvas.group',
      group: 'structure',
      order: 20,
      visible: () => selection.ids.length >= 2,
    },
    {
      id: 'menu.ungroup',
      command: 'canvas.ungroup',
      group: 'structure',
      order: 21,
      visible: () => selection.ids.length >= 1,
    },
    {
      id: 'menu.orderFront',
      command: 'canvas.orderFront',
      group: 'layer',
      order: 30,
      visible: hasSelection,
    },
    {
      id: 'menu.orderForward',
      command: 'canvas.orderForward',
      group: 'layer',
      order: 31,
      visible: hasSelection,
    },
    {
      id: 'menu.orderBackward',
      command: 'canvas.orderBackward',
      group: 'layer',
      order: 32,
      visible: hasSelection,
    },
    {
      id: 'menu.orderBack',
      command: 'canvas.orderBack',
      group: 'layer',
      order: 33,
      visible: hasSelection,
    },
    {
      id: 'menu.hidden',
      command: 'canvas.toggleHidden',
      group: 'state',
      order: 40,
      visible: hasSelection,
    },
    {
      id: 'menu.lock',
      command: 'canvas.toggleLock',
      group: 'state',
      order: 41,
      visible: hasSelection,
    },
    {
      id: 'menu.zoomToSelection',
      command: 'canvas.zoomToSelection',
      group: 'view',
      order: 50,
      visible: hasSelection,
    },
    { id: 'menu.zoomFit', command: 'canvas.zoomFit', group: 'view', order: 51 },
    { id: 'menu.zoomReset', command: 'canvas.zoomReset', group: 'view', order: 52 },
    { id: 'menu.selectAll', command: 'canvas.selectAll', group: 'view', order: 53 },
  ]
}
