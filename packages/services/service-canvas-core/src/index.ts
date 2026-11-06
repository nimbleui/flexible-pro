import type {
  CanvasContext,
  CanvasService,
  DocumentService,
  MaterialService,
  NodeFlagView,
  SelectionService,
} from '@lc/contracts'
import { EMPTY_NODE_FLAGS, resolveNodeFlags } from '@lc/contracts'
import { definePlugin } from '@lc/kernel'
import type { Disposable } from '@lc/kernel'
import type { NodeSchema, Rect } from '@lc/schema'
import { paintOrder } from '@lc/schema'
import {
  createContextMenuService,
  createHitTest,
  createInteractionPipeline,
  createLayerService,
  createMeasure,
  createScene,
  createScheduler,
  createSettingsService,
  createTransactionService,
  createViewport,
} from '@lc/canvas'

/** 无 layout 信息时的兜底节点尺寸（屏幕与拖拽预览用） */
const DEFAULT_NODE_WIDTH = 100
const DEFAULT_NODE_HEIGHT = 40

/** 拷贝一份矩形给场景，避免调用方后续改动写回 schema */
function nodeRect(node: NodeSchema | undefined): Rect {
  const rect = node?.layout?.rect
  if (rect) return { ...rect }
  return { x: 0, y: 0, width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT }
}

/**
 * 画布核心服务插件（CanvasRealm 级）。
 *
 * 提供 `ctx.canvas` 与全部画布子服务；插件用 `canvas-interaction`、
 * `canvas-layers` 等扩展点挂能力，画布内核本身不认识缩放/吸附/选择。
 */
export default definePlugin({
  name: 'service-canvas-core',
  inject: ['document', 'selection'],

  apply(ctx) {
    const document = ctx.require<DocumentService>('document')
    const selection = ctx.require<SelectionService>('selection')

    // 显式写死缩放区间：与视口默认值相同，放在这里是为了让产品调整只改一处
    const viewport = createViewport({ minZoom: 0.1, maxZoom: 4 })

    /**
     * 隐藏 / 锁定集合，每次文档同步时整体替换。
     *
     * 命中测试与场景登记都要读它，但两者读取时机不同（前者在指针事件里，
     * 后者在同步过程中），所以放在同一处推导、各自取用，避免两套结论。
     */
    let nodeFlags: NodeFlagView = EMPTY_NODE_FLAGS

    const scheduler = createScheduler()
    const settings = createSettingsService()
    const layers = createLayerService()
    const contextMenu = createContextMenuService()

    const scene = createScene({
      // 根矩形取 schema.nodeId 指向的节点；根不存在时回落到 100×40 兜底尺寸，
      // 此时 fit 会把视图放到极小区域，属于文档损坏下的可观察降级而不是抛错
      getRootRect: () => {
        const rootId = document.model.schema.nodeId
        return nodeRect(document.model.schema.nodes[rootId])
      },
    })

    /**
     * 容器判定：先看有没有实际子节点，再问物料声明。
     *
     * children 非空直接算容器，这样常见路径不用查物料表；空容器能否接收拖入
     * 完全取决于物料的 container 标记。物料服务是可选的，未安装时只有带子节点
     * 的节点会被判为容器。
     * 锁定容器不接收拖入：命中测试会继续向下寻找未锁定的容器，而不是把节点
     * 投进一个点不到也拖不动的父级里。
     */
    const isContainer = (nodeId: string): boolean => {
      if (nodeFlags.locked.has(nodeId)) return false
      const node = document.model.schema.nodes[nodeId]
      if (!node) return false
      if ((node.children?.length ?? 0) > 0) return true
      return ctx.get<MaterialService>('material')?.get(node.componentName)?.container === true
    }

    /**
     * 节点自转角，弧度。
     *
     * schema 按 CSS 语义存度数，画布几何统一用弧度，换算只在这里发生一次。
     * 命中测试逐节点调用，因此只读上一次同步后的文档对象，不查物料表、不测 DOM。
     */
    const nodeRotation = (nodeId: string): number => {
      const degrees = document.model.schema.nodes[nodeId]?.layout?.rotate ?? 0
      return (degrees * Math.PI) / 180
    }

    const hitTest = createHitTest({
      scene,
      viewport,
      isContainer,
      getRotation: nodeRotation,
      // 处理器在指针事件里同步调用，这里只查上一次文档同步算出的集合。
      // 画幅根保留在命中结果里：选中它才能编辑页面属性；「不可移动 / 不可缩放」属于变换
      // 闸门（transformableIds 与 handleTargetIds），不在命中这一层表达
      isSelectable: (nodeId) => !nodeFlags.locked.has(nodeId),
    })
    const measure = createMeasure(scene)

    const interaction = createInteractionPipeline({
      viewport,
      hitTest,
      diagnostics: ctx.diagnostics,
      // 处理器在事件发生时执行，此时 canvas 服务已 provide
      getContext: () => ctx as CanvasContext,
    })

    const transaction = createTransactionService({
      document,
      onEnd: (info) => ctx.emit('canvas:gestureEnd', info),
    })

    /** 已登记几何的节点 → 最近一次 disposable，用于节点删除时清理 */
    const registrations = new Map<string, Disposable>()

    /**
     * 把当前 schema 的节点几何同步进场景。
     *
     * 登记顺序取自绘制顺序（图层树深度优先、父在前），命中测试按逆序取最上层，
     * 于是「点谁」和「谁盖住谁」始终一致；层级命令改写的就是这个顺序。
     * 顺序没变时逐节点覆盖矩形即可——场景按 nodeId 复用首次登记的位置，所以拖拽
     * 期间每帧重同步都不会打乱层级；只有结构变化才整表撤下重新登记。
     * 隐藏子树不在绘制顺序里，几何因此不登记：看不见也不该被点中。
     * 末尾只标记一次视口脏，逐节点的 register 通知不会各自触发一轮重绘。
     */
    function syncScene(): void {
      const schema = document.model.schema
      nodeFlags = resolveNodeFlags(schema)

      const ids = paintOrder(schema)
      const current = scene.list()
      const orderChanged =
        ids.length !== current.length || ids.some((id, index) => current[index] !== id)

      if (orderChanged) {
        for (const disposable of [...registrations.values()]) disposable.dispose()
        registrations.clear()
      }

      const present = new Set(ids)
      for (const nodeId of ids) {
        const previous = registrations.get(nodeId)
        const next = scene.register(nodeId, nodeRect(schema.nodes[nodeId]))
        // 旧 disposable 因 token 校验不会删掉刚更新的几何，这里只释放引用
        previous?.dispose()
        registrations.set(nodeId, next)
      }

      // 节点被删或转为隐藏后必须显式注销，否则它的矩形会一直留在场景里参与命中
      for (const [nodeId, disposable] of [...registrations]) {
        if (present.has(nodeId)) continue
        disposable.dispose()
        registrations.delete(nodeId)
      }

      scheduler.invalidateViewport()
    }

    syncScene()

    // 三路脏源统一收敛到调度器：文档、视口、选中的变化都只安排一次帧提交
    ctx.effect(() => document.onDidChange(() => syncScene()))
    ctx.effect(() => viewport.onDidChange(() => scheduler.invalidateViewport()))
    ctx.effect(() => selection.onDidChange(() => scheduler.invalidateViewport()))

    // 调度器由本插件创建，销毁权也在这里：残留的 rAF 与兜底定时器会跨文档泄漏
    ctx.effect(() => ({ dispose: () => scheduler.dispose() }))

    const service: CanvasService = {
      viewport,
      scene,
      hitTest,
      measure,
      selection,
      interaction,
      layers,
      contextMenu,
      transaction,
      settings,
      scheduler,

      // getter 而不是快照字段：syncScene 整体替换对象，读取方每次拿到的都是最新集合
      get nodeFlags(): NodeFlagView {
        return nodeFlags
      },

      /**
       * 挂载舞台：交互管线 + 视口尺寸测量。
       *
       * 先绑监听再同步量一次尺寸，保证第一次 pointerdown 时 viewport.size 已可用
       * （未测量的尺寸会让 fit 直接跳过）。Node 环境没有 ResizeObserver，
       * 此时只有首次测量，尺寸变化需要宿主自行调用 setSize。
       */
      attach(element: HTMLElement): Disposable {
        const detachInteraction = interaction.attach(element)

        // 量的是 clientWidth/Height：舞台 overflow:hidden，内容尺寸与可视尺寸一致
        const applySize = (): void => {
          viewport.setSize({ width: element.clientWidth, height: element.clientHeight })
        }
        applySize()

        const observer =
          typeof ResizeObserver === 'function' ? new ResizeObserver(applySize) : null
        observer?.observe(element)

        return {
          dispose: () => {
            // 先停观察再解绑交互，最后把尺寸归零：卸载后残留尺寸会让 fit 算出错误缩放
            observer?.disconnect()
            detachInteraction.dispose()
            viewport.setSize({ width: 0, height: 0 })
          },
        }
      },
    }

    ctx.effect(() => ctx.provide('canvas', service, { apiVersion: '1.0' }))
  },
})
