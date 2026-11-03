import type {
  CanvasTransaction,
  CommandContext,
  KeybindingService,
  SchemaPatch,
} from '@lc/contracts'
import { defineCanvasPlugin, transformableIds } from '@lc/contracts'
import type { NodeFlagChange, OrderMode } from '@lc/schema'
import { changeOrders, groupNodes, setNodeFlags, ungroupNodes } from '@lc/schema'
import { createId } from '@lc/shared'
import { copySubtrees, deleteSelection, insertSubtrees, nudgeSelection } from './operations'
import type { SubtreeSet } from './operations'

export { manifest } from './manifest'

const OWNER = 'canvas-commands'
const PASTE_OFFSET = 20

/** 层级命令的历史标签：一次操作一条历史，标签写清改了哪个方向 */
const ORDER_LABELS: Record<OrderMode, string> = {
  front: '置于顶层',
  forward: '上移一层',
  backward: '下移一层',
  back: '置于底层',
}

/**
 * 编辑命令与快捷键插件。
 *
 * 删除/粘贴/再制/微调全部通过事务提交，一次操作一条历史；
 * 复制只写内存剪贴板，不触碰文档。快捷键只声明「键位 → 命令」，
 * 命令的启用条件由 `enabled()` 统一决定。
 */
export default defineCanvasPlugin({
  name: 'canvas-commands',
  // keybinding 只负责「键位 → 命令」的附加层，没装它命令仍然可以从菜单/工具栏执行
  inject: {
    required: ['canvas', 'command', 'document', 'history'],
    optional: ['keybinding'],
  },

  apply(ctx) {
    const canvas = ctx.canvas
    const document = ctx.document
    const history = ctx.history
    const keybinding = ctx.keybinding

    let clipboard: SubtreeSet | null = null

    const schema = () => document.model.schema
    const selectedIds = (): string[] => [...canvas.selection.ids]
    /**
     * 可被编辑命令作用的选中节点。
     *
     * 锁定节点（含祖先被锁定）必须先解锁才能删/复制/微调；隐藏节点不在此列——
     * 图层树里选中隐藏节点后删除它是正当操作，命令的快捷键只响应舞台焦点。
     */
    const editableIds = (): string[] =>
      transformableIds(selectedIds(), schema()).filter((id) => id !== schema().nodeId)

    function commit(patches: SchemaPatch[], label: string): boolean {
      if (patches.length === 0) return false

      let transaction: CanvasTransaction
      try {
        transaction = canvas.transaction.begin({ label, owner: OWNER })
      } catch {
        return false
      }
      transaction.preview(patches)
      transaction.commit()
      return true
    }

    function duplicate(ids: string[], label: string): void {
      if (ids.length === 0) return
      const result = insertSubtrees(schema(), copySubtrees(schema(), ids), {
        offset: PASTE_OFFSET,
        createId: () => createId('node'),
      })
      if (commit(result.patches, label)) canvas.selection.set(result.newRootIds)
    }

    function deleteSelected(): void {
      const ids = editableIds()
      if (ids.length === 0) return
      if (!commit(deleteSelection(schema(), ids), '删除节点')) return

      const removed = new Set(ids)
      canvas.selection.set(selectedIds().filter((id) => !removed.has(id)))
    }

    function copySelected(): void {
      const ids = editableIds()
      if (ids.length === 0) return
      clipboard = copySubtrees(schema(), ids)
    }

    function paste(): void {
      if (!clipboard) return
      const result = insertSubtrees(schema(), clipboard, {
        offset: PASTE_OFFSET,
        createId: () => createId('node'),
      })
      if (commit(result.patches, '粘贴节点')) canvas.selection.set(result.newRootIds)
    }

    function nudge(commandCtx: CommandContext): void {
      // args 由键绑定表注入，服务层只保证 unknown；这里按约定的形状窄化，
      // 缺省按 0 处理而不是报错，保证命令被无参调用时安全落空
      const args = (commandCtx.args ?? {}) as {
        /** x 轴位移（世界单位，正方向向右） */
        dx?: number
        /** y 轴位移（世界单位，正方向向下） */
        dy?: number
      }
      const ids = editableIds()
      if (ids.length === 0) return
      commit(nudgeSelection(schema(), ids, args.dx ?? 0, args.dy ?? 0), '微调位置')
    }

    function changeOrder(mode: OrderMode): void {
      const ids = editableIds()
      if (ids.length === 0) return
      commit(changeOrders(schema(), ids, mode), ORDER_LABELS[mode])
    }

    function groupSelected(): void {
      const result = groupNodes(schema(), editableIds(), { createId: () => createId('node') })
      if (!result) return
      if (commit(result.patches, '组合节点')) canvas.selection.set([result.groupId])
    }

    /** 解组后选中成员而不是组：组已经不在了，留空选中会让人以为操作失败 */
    function ungroupSelected(): void {
      const groups = editableIds().filter(
        (id) => (schema().nodes[id]?.children?.length ?? 0) > 0,
      )
      if (groups.length === 0) return
      const members = [...new Set(groups.flatMap((id) => schema().nodes[id]?.children ?? []))]
      if (!commit(ungroupNodes(schema(), groups), '取消组合')) return
      canvas.selection.set(members)
    }

    const hasGroupSelected = (): boolean =>
      editableIds().some((id) => (schema().nodes[id]?.children?.length ?? 0) > 0)

    /**
     * 切换选中节点的显隐 / 锁定。
     *
     * 判定只看节点自己的标记：继承来的状态（祖先被锁定）改这个节点解除不了，
     * 所以「全部已标记 → 取消，否则 → 加上」这条规则与图层树上的图标一致。
     */
    function toggleFlag(field: 'hidden' | 'locked'): void {
      const ids = editableIds()
      if (ids.length === 0) return

      const turnOff = ids.every((id) => schema().nodes[id]?.[field] === true)
      const next = !turnOff
      const flags: NodeFlagChange = field === 'hidden' ? { hidden: next } : { locked: next }
      const label =
        field === 'hidden' ? (next ? '隐藏节点' : '显示节点') : next ? '锁定节点' : '解锁节点'

      commit(setNodeFlags(schema(), ids, flags), label)
    }

    const commands = [
      {
        id: 'canvas.deleteSelection',
        title: '删除选中节点',
        enabled: () => editableIds().length > 0,
        run: () => deleteSelected(),
      },
      {
        id: 'canvas.copySelection',
        title: '复制选中节点',
        enabled: () => editableIds().length > 0,
        run: () => copySelected(),
      },
      {
        id: 'canvas.pasteSelection',
        title: '粘贴节点',
        enabled: () => clipboard !== null,
        run: () => paste(),
      },
      {
        id: 'canvas.duplicateSelection',
        title: '再制选中节点',
        enabled: () => editableIds().length > 0,
        run: () => duplicate(editableIds(), '再制节点'),
      },
      {
        id: 'canvas.selectAll',
        title: '全选节点',
        enabled: () => Object.keys(schema().nodes).length > 1,
        // 全选只收「在画布上够得着」的节点：隐藏节点没有几何、锁定节点改不动，
        // 收进选中集只会让后续批量变换出现看不见的例外
        run: () =>
          canvas.selection.set(
            Object.keys(schema().nodes).filter(
              (id) =>
                id !== schema().nodeId &&
                !canvas.nodeFlags.hidden.has(id) &&
                !canvas.nodeFlags.locked.has(id),
            ),
          ),
      },
      {
        id: 'canvas.nudgeSelection',
        title: '微调选中节点',
        enabled: () => editableIds().length > 0,
        run: (commandCtx: CommandContext) => nudge(commandCtx),
      },
      {
        id: 'canvas.orderFront',
        title: '置于顶层',
        enabled: () => editableIds().length > 0,
        run: () => changeOrder('front'),
      },
      {
        id: 'canvas.orderForward',
        title: '上移一层',
        enabled: () => editableIds().length > 0,
        run: () => changeOrder('forward'),
      },
      {
        id: 'canvas.orderBackward',
        title: '下移一层',
        enabled: () => editableIds().length > 0,
        run: () => changeOrder('backward'),
      },
      {
        id: 'canvas.orderBack',
        title: '置于底层',
        enabled: () => editableIds().length > 0,
        run: () => changeOrder('back'),
      },
      {
        id: 'canvas.group',
        title: '组合选中节点',
        enabled: () => editableIds().length >= 2,
        run: () => groupSelected(),
      },
      {
        id: 'canvas.ungroup',
        title: '取消组合',
        enabled: hasGroupSelected,
        run: () => ungroupSelected(),
      },
      {
        id: 'canvas.toggleLock',
        title: '锁定 / 解锁选中节点',
        enabled: () => editableIds().length > 0,
        run: () => toggleFlag('locked'),
      },
      {
        id: 'canvas.toggleHidden',
        title: '隐藏 / 显示选中节点',
        enabled: () => editableIds().length > 0,
        run: () => toggleFlag('hidden'),
      },
      {
        id: 'canvas.undo',
        title: '撤销',
        enabled: () => history.canUndo,
        run: () => history.undo(),
      },
      {
        id: 'canvas.redo',
        title: '重做',
        enabled: () => history.canRedo,
        run: () => history.redo(),
      },
    ]

    for (const command of commands) {
      ctx.effect(() => ctx.command.register(command))
    }

    const bindings: Array<{
      /** 键位绑定 id，用于卸载与冲突诊断 */
      id: string
      /** 键位序列，Mod = Ctrl/⌘；由键位服务解析，本表只声明组合 */
      key: string
      /** 目标命令 id，必须与上面 commands 表里的注册 id 一致 */
      command: string
      /** 传给命令的上下文参数；微调类用它携带位移量 */
      args?: unknown
    }> = [
      { id: 'canvas-commands.delete', key: 'Delete', command: 'canvas.deleteSelection' },
      { id: 'canvas-commands.backspace', key: 'Backspace', command: 'canvas.deleteSelection' },
      { id: 'canvas-commands.copy', key: 'Mod+C', command: 'canvas.copySelection' },
      { id: 'canvas-commands.paste', key: 'Mod+V', command: 'canvas.pasteSelection' },
      { id: 'canvas-commands.duplicate', key: 'Mod+D', command: 'canvas.duplicateSelection' },
      { id: 'canvas-commands.selectAll', key: 'Mod+A', command: 'canvas.selectAll' },
      { id: 'canvas-commands.undo', key: 'Mod+Z', command: 'canvas.undo' },
      { id: 'canvas-commands.redo', key: 'Mod+Shift+Z', command: 'canvas.redo' },
      {
        id: 'canvas-commands.nudgeLeft',
        key: 'ArrowLeft',
        command: 'canvas.nudgeSelection',
        args: { dx: -1, dy: 0 },
      },
      {
        id: 'canvas-commands.nudgeRight',
        key: 'ArrowRight',
        command: 'canvas.nudgeSelection',
        args: { dx: 1, dy: 0 },
      },
      {
        id: 'canvas-commands.nudgeUp',
        key: 'ArrowUp',
        command: 'canvas.nudgeSelection',
        args: { dx: 0, dy: -1 },
      },
      {
        id: 'canvas-commands.nudgeDown',
        key: 'ArrowDown',
        command: 'canvas.nudgeSelection',
        args: { dx: 0, dy: 1 },
      },
      {
        id: 'canvas-commands.nudgeFastLeft',
        key: 'Shift+ArrowLeft',
        command: 'canvas.nudgeSelection',
        args: { dx: -10, dy: 0 },
      },
      {
        id: 'canvas-commands.nudgeFastRight',
        key: 'Shift+ArrowRight',
        command: 'canvas.nudgeSelection',
        args: { dx: 10, dy: 0 },
      },
      {
        id: 'canvas-commands.nudgeFastUp',
        key: 'Shift+ArrowUp',
        command: 'canvas.nudgeSelection',
        args: { dx: 0, dy: -10 },
      },
      {
        id: 'canvas-commands.nudgeFastDown',
        key: 'Shift+ArrowDown',
        command: 'canvas.nudgeSelection',
        args: { dx: 0, dy: 10 },
      },
      { id: 'canvas-commands.orderForward', key: 'Mod+]', command: 'canvas.orderForward' },
      { id: 'canvas-commands.orderBackward', key: 'Mod+[', command: 'canvas.orderBackward' },
      { id: 'canvas-commands.orderFront', key: 'Mod+Alt+]', command: 'canvas.orderFront' },
      { id: 'canvas-commands.orderBack', key: 'Mod+Alt+[', command: 'canvas.orderBack' },
      { id: 'canvas-commands.group', key: 'Mod+G', command: 'canvas.group' },
      { id: 'canvas-commands.ungroup', key: 'Mod+Shift+G', command: 'canvas.ungroup' },
      { id: 'canvas-commands.toggleLock', key: 'Mod+Shift+L', command: 'canvas.toggleLock' },
      {
        id: 'canvas-commands.toggleHidden',
        key: 'Mod+Shift+H',
        command: 'canvas.toggleHidden',
      },
    ]

    const keybindingService: KeybindingService | undefined = keybinding
    if (keybindingService) {
      for (const binding of bindings) {
        ctx.effect(() => keybindingService.register(binding))
      }
    }
  },
})
