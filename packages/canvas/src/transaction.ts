import type {
  CanvasTransaction,
  DocumentService,
  GestureEndPayload,
  SchemaPatch,
  TransactionService,
} from '@lc/contracts'
import type { PageSchema } from '@lc/schema'

/** 事务服务创建选项 */
export interface CreateTransactionOptions {
  /** 文档服务；事务通过它预览与提交 */
  document: DocumentService

  /**
   * 事务结束回调；画布内核用它广播 `canvas:gestureEnd`，info 即该事件的载荷类型：
   * owner / label 与 `begin` 传入值一致（内核用 owner 判断是否自己的手势，label 与
   * 写入历史记录的 label 是同一个字符串）。
   *
   * committed 为 false 表示取消或撤销，此时文档已被恢复到手势前状态。注意只有
   * `cancel` 与「未提交就 dispose」是 false；`commit` 即使一条预览都没有（只回退
   * 文档、不写历史）也报 true，宿主不要据它判断「历史里多了一条」。回调在 active
   * 清空之后执行，因此回调里可以立刻 begin 下一次事务；未传时事务照常工作，只是
   * 外部收不到结束通知。
   */
  onEnd?: (info: GestureEndPayload) => void
}

/** 一次活动手势事务的内部状态 */
interface ActiveTransaction {
  /** 发起方插件 id；用于冲突报错与 onEnd 归因，不参与事务逻辑判定 */
  owner: string

  /** 展示用的事务名；同时作为写入历史记录的 label */
  label: string

  /** begin 时刻的 schema 快照：cancel 的回退基准，也是 commit 写入历史的 before */
  base: PageSchema

  /** path → 最后一次预览 patch；同一 path 多次预览只保留最新值 */
  pending: Map<string, SchemaPatch>

  /** 是否已结束；防止 commit / cancel / dispose 重复触发 onEnd */
  closed: boolean
}

/**
 * 创建手势事务服务。
 *
 * 预览直接写文档但不产生历史；提交时把最终 patch 落在当前文档上，并以手势前的
 * 快照作为历史的 before，保证「一次拖拽 = 一条历史」且不吞掉并发改动。
 * 同一时刻只允许一个事务，抢不到 `begin` 的插件应放弃本次手势。
 */
export function createTransactionService(
  options: CreateTransactionOptions,
): TransactionService {
  let active: ActiveTransaction | null = null

  /**
   * 结束事务并通知宿主。
   *
   * 幂等：重复调用只触发一次 onEnd。先清 active 再回调，保证 onEnd 里可以
   * 立即开始下一次手势。cancel、commit 与 dispose 走的都是这一条出口。
   */
  function close(state: ActiveTransaction, committed: boolean): void {
    if (state.closed) return
    state.closed = true
    if (active === state) active = null
    options.onEnd?.({ owner: state.owner, label: state.label, committed })
  }

  /**
   * 组装事务句柄。
   *
   * 与 `begin` 分开有两个原因：`begin` 只需要回答「这次手势能不能开始」，而
   * preview / commit / cancel 的全部规则都围绕 `state.closed` 与 pending 去重；
   * 抽出来后文档写入逻辑不再嵌在 `begin` 的返回值里。
   *
   * 句柄只闭包引用传入的 state，因此事务已经结束后迟到的 preview / commit 会
   * 静默失效而不抛错——手势回调常在 pointerup 之后才落地，抛错会打断整条链路。
   */
  function createTransactionHandle(state: ActiveTransaction): CanvasTransaction {
    return {
      get closed() {
        return state.closed
      },

      preview(patches) {
        // 以 path 去重：同一目标反复预览只保留最后一次，提交时不会累积中间态。
        // 事务已结束（提交或取消）时静默忽略，避免迟到的回调再改文档。
        if (state.closed) return
        for (const patch of patches) state.pending.set(patch.path, patch)
        options.document.apply(patches, { record: false })
      },

      /**
       * 提交为一条历史记录。
       *
       * 把去重后的最终 patch 直接落在当前文档上，并用 `before: base` 记录手势前的
       * 状态：预览期间逐帧写入的中间态不进历史，撤销一次即回到手势开始前。
       * 不能先 `restore(base)` 再重放——那会把手势期间别处的写入（属性面板改了同一
       * 节点的其它字段、拖入的新节点）整体抹掉，而且不产生任何错误。
       * 代价是与本事务同路径的并发写入由本事务的最后一次预览覆盖，即手势独占它
       * 改过的路径；撤销则回到 base，这条限制同样成立。
       *
       * pending 为空时只回退、不写历史，等于把预览完全撤销。
       */
      commit() {
        if (state.closed) return
        if (state.pending.size > 0) {
          options.document.apply([...state.pending.values()], {
            record: true,
            label: state.label,
            before: state.base,
          })
        } else {
          options.document.restore(state.base)
        }
        close(state, true)
      },

      /** 取消并回到 base；不写历史，但仍会触发 onEnd(committed=false)。 */
      cancel() {
        if (state.closed) return
        options.document.restore(state.base)
        close(state, false)
      },
    }
  }

  return {
    /**
     * 开始一次手势事务。
     *
     * base 直接引用当时的 schema：文档写入走拷贝式 patch，旧对象不会被改动，
     * 因此无需深拷贝即可作为回退基准。
     *
     * @throws 已存在活动事务时抛错。
     */
    begin({ label, owner }): CanvasTransaction {
      if (active) {
        throw new Error(`[canvas] 已存在活动事务: ${active.label}(${active.owner})`)
      }

      const state: ActiveTransaction = {
        owner,
        label,
        base: options.document.model.schema,
        pending: new Map(),
        closed: false,
      }
      active = state

      return createTransactionHandle(state)
    },
  }
}
