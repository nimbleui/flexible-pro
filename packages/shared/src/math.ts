/**
 * 把数值约束到闭区间 [min, max]。
 *
 * 视口缩放、吸附阈值等都要经过它，避免插件传入越界值把画布状态弄坏。
 */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new Error(`[lc] clamp 区间非法: min=${min} max=${max}`)
  }
  return Math.min(max, Math.max(min, value))
}
