import { defineCanvasPlugin } from '@lc/contracts'
import type { ConfigSchema } from '@lc/kernel'
import { createSnapService } from '@lc/canvas'
import { elementCandidates, gridCandidates } from './providers'

/** 吸附插件配置 */
export interface SnapPluginConfig {
  /**
   * 屏幕像素阈值 @default 6
   *
   * 引擎内部按 zoom 换算成世界单位；只影响判定距离，不影响辅助线显示范围。
   */
  thresholdScreenPx: number

  /**
   * 网格步长（世界像素） @default 8
   *
   * 与 canvas-grid 的 `GRID_SETTING` 是两份独立配置：本值决定吸附到哪条网格线，
   * 那项决定网格画在哪，只改其一会出现「吸附线看不见、看得见的线吸不上」。
   */
  gridSize: number
}

const schema: ConfigSchema<SnapPluginConfig> = {
  /** 缺字段或类型不符时逐项回落到默认值，而不是让整份配置解析失败 */
  parse(input) {
    const raw = (input ?? {}) as Partial<SnapPluginConfig>
    return {
      thresholdScreenPx: typeof raw.thresholdScreenPx === 'number' ? raw.thresholdScreenPx : 6,
      gridSize: typeof raw.gridSize === 'number' ? raw.gridSize : 8,
    }
  },
}

export { manifest } from './manifest'

/**
 * 吸附插件：提供 `snap` 服务并注册网格 / 节点两类候选。
 *
 * 引擎与 provider 分离：拖拽/缩放通过可选 inject 使用；
 * 未安装本插件时这些能力仍然工作，只是不吸附。
 */
export default defineCanvasPlugin<SnapPluginConfig>({
  name: 'canvas-snap',
  inject: ['canvas'],
  provides: ['snap'],
  schema,

  apply(ctx, config) {
    const canvas = ctx.canvas

    const service = createSnapService({
      thresholdScreenPx: config.thresholdScreenPx,
      onError: (error, providerId) => {
        ctx.diagnostics.report(error, { scope: 'snap', providerId })
      },
    })

    ctx.effect(() => ctx.provide('snap', service, { apiVersion: '1.0' }))

    ctx.effect(() =>
      service.registerProvider({
        id: 'snap.grid',
        getCandidates: (context) => gridCandidates(context, config.gridSize),
      }),
    )

    ctx.effect(() =>
      service.registerProvider({
        id: 'snap.elements',
        // 候选取自本画布的场景登记，而不是文档节点表：场景是画布的通用几何来源；
        // 隐藏子树不登记几何，因此也不会被吸到。
        getCandidates: (context) => {
          const elements = canvas.scene.list().flatMap((id) => {
            const rect = canvas.scene.getBounds(id)
            return rect ? [{ id, rect }] : []
          })
          return elementCandidates(context, elements)
        },
      }),
    )
  },
})
