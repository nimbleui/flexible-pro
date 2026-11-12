import { describe, expect, it } from 'vitest'
import { shouldExpandDockByDefault } from '../src/views/composables/use-designer-rail'

/**
 * 外壳纵向 chrome 在 dock 展开态占 495px（宽屏）、483px（≤1440）。
 *
 * 495 = 各处声明值合计 493 + .lc-designer__stage 上下边框 2px，与 1920×1080 实测
 * （内层舞台 585）一致；≤1440 的 media query 再收 12px。边界例取宽屏口径：
 * 815 恰好让舞台达到 320px 下限。
 */
describe('底部停靠区的首次默认态', () => {
  it('1080p 屏（窗口高约 950）保持展开，舞台还剩约 455px', () => {
    expect(shouldExpandDockByDefault(950)).toBe(true)
  })

  it('1366×768 屏（窗口高约 648）默认折叠，否则舞台只剩约 153px', () => {
    expect(shouldExpandDockByDefault(648)).toBe(false)
  })

  it('实测过的那个 785px 窗口判为折叠', () => {
    expect(shouldExpandDockByDefault(785)).toBe(false)
  })

  it('窗口高 815 恰好让舞台达到 320px 下限，取展开', () => {
    expect(shouldExpandDockByDefault(815)).toBe(true)
  })

  it('比下限少 1px 就折叠', () => {
    expect(shouldExpandDockByDefault(814)).toBe(false)
  })

  it('窗口高为 0（窗口尚未就绪 / 极端缩放）按折叠处理', () => {
    expect(shouldExpandDockByDefault(0)).toBe(false)
  })
})
