import type { CanvasTransaction } from '@lc/contracts'
import { defineCanvasPlugin, handleTargetIds } from '@lc/contracts'
import { createNodeLayoutPatch } from '@lc/schema'
import { alignRects, distributeRects } from './align'
import type { AlignMode, AlignNode } from './align'

export { manifest } from './manifest'

/** 对齐命令的声明与执行参数 */
interface AlignCommand {
  /** 命令 id，工具栏与快捷键按它调用 */
  id: string
  /** 命令面板展示名 */
  title: string
  /** 传给 alignRects 的方位 */
  mode: AlignMode
  /** 写入历史条目的标签；与 title 分开是因为两者面向的界面不同 */
  label: string
}

const ALIGN_COMMANDS: readonly AlignCommand[] = [
  { id: 'canvas.alignLeft', title: '左对齐', mode: 'left', label: '左对齐' },
  { id: 'canvas.alignCenterX', title: '水平居中', mode: 'centerX', label: '水平居中' },
  { id: 'canvas.alignRight', title: '右对齐', mode: 'right', label: '右对齐' },
  { id: 'canvas.alignTop', title: '顶对齐', mode: 'top', label: '顶对齐' },
  { id: 'canvas.alignCenterY', title: '垂直居中', mode: 'centerY', label: '垂直居中' },
  { id: 'canvas.alignBottom', title: '底对齐', mode: 'bottom', label: '底对齐' },
]

/**
 * 对齐与分布插件。
 *
 * 命令是唯一执行入口：工具栏按钮只声明命令 id，具体逻辑在这里。
 * 每次执行是一个独立事务，写入一条历史；对齐至少要 2 个节点，
 * 分布至少要 3 个节点，不满足时命令置灰且 `execute` 直接跳过。
 */
export default defineCanvasPlugin({
  name: 'canvas-align',
  inject: ['canvas', 'command'],

  apply(ctx) {
    const canvas = ctx.canvas

    /** 取当前选中集中可参与对齐的世界矩形；画幅根、锁定与尚未登记几何的节点被排除 */
    function collect(): AlignNode[] {
      const nodes: AlignNode[] = []
      // 对齐的参与者与出得了手柄的那批节点同源：画幅根是被对齐的参照物，不能被搬走
      for (const id of handleTargetIds(canvas.selection.ids, canvas.nodeFlags)) {
        // 隐藏节点压根不在场景里，getBounds 拿不到
        const rect = canvas.scene.getBounds(id)
        if (rect) nodes.push({ id, rect })
      }
      return nodes
    }

    /**
     * 把一次对齐/分布落成一条历史。
     *
     * 对齐没有中间态，所以 preview 后立刻 commit：走同一套事务入口才能保证
     * 撤销粒度与手势类操作一致。别的手势持有事务时静默放弃本次操作。
     */
    function commit(changes: AlignNode[], label: string): void {
      if (changes.length === 0) return

      let transaction: CanvasTransaction
      try {
        transaction = canvas.transaction.begin({ label, owner: 'canvas-align' })
      } catch {
        return
      }

      transaction.preview(
        changes.flatMap(({ id, rect }) => createNodeLayoutPatch(id, { rect })),
      )
      transaction.commit()
    }

    /** 与命令 enabled 同源的数量判定，绕过置灰直接执行也不会写入无意义的历史 */
    function runAlign(command: AlignCommand): void {
      const nodes = collect()
      if (nodes.length < 2) return
      commit(alignRects(nodes, command.mode), command.label)
    }

    /** 分布需要至少 3 个节点，2 个时首尾已固定、没有可重排的中间节点 */
    function runDistribute(axis: 'x' | 'y', label: string): void {
      const nodes = collect()
      if (nodes.length < 3) return
      commit(distributeRects(nodes, axis), label)
    }

    for (const command of ALIGN_COMMANDS) {
      ctx.effect(() =>
        ctx.command.register({
          id: command.id,
          title: command.title,
          // 置灰条件与 run 里的数量判定同源，避免出现「可点但什么都不做」
          enabled: () => collect().length >= 2,
          run: () => runAlign(command),
        }),
      )
    }

    ctx.effect(() =>
      ctx.command.register({
        id: 'canvas.distributeX',
        title: '水平分布',
        enabled: () => collect().length >= 3,
        run: () => runDistribute('x', '水平分布'),
      }),
    )

    ctx.effect(() =>
      ctx.command.register({
        id: 'canvas.distributeY',
        title: '垂直分布',
        enabled: () => collect().length >= 3,
        run: () => runDistribute('y', '垂直分布'),
      }),
    )
  },
})
