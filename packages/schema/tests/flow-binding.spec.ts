import { describe, expect, it } from 'vitest'
import type { FlowDefinition } from '@lc/schema'
import { DEFAULT_FLOW_SETTINGS, flowBindingSummary, listFlowBindingOptions } from '@lc/schema'

/** 只填必要字段的流程图 */
function makeFlow(
  id: string,
  name: string,
  status: FlowDefinition['status'] = 'published',
): FlowDefinition {
  return {
    id,
    name,
    status,
    version: '1.0.0',
    updatedAt: '2026-11-01T00:00:00.000Z',
    nodes: {},
    edges: {},
    settings: { ...DEFAULT_FLOW_SETTINGS },
  }
}

const FLOWS = [makeFlow('f1', '审批'), makeFlow('f2', '还在画', 'draft')]

describe('listFlowBindingOptions', () => {
  it('草稿也列出来，但标注为暂不生效', () => {
    /**
     * 把草稿藏起来只会让人以为「这里不能选流程」；列出来并说明还不生效，
     * 下一步该做什么（去发布）才是可见的。
     */
    expect(listFlowBindingOptions(FLOWS)).toEqual([
      { value: 'f1', label: '审批', description: '', effective: true },
      {
        value: 'f2',
        label: '还在画',
        description: '草稿，发布后页面事件才会执行它',
        effective: false,
      },
    ])
  })

  it('当前绑定的图已不存在时补一条占位，而不是让下拉显示未选择', () => {
    // 悬空引用被显示成「未选择」，用户就永远发现不了那条永远不会生效的绑定
    const options = listFlowBindingOptions(FLOWS, 'ghost')

    expect(options[0]).toEqual({
      value: 'ghost',
      label: '流程图 ghost（已不存在）',
      description: '绑定的图已被删除，这个事件只会执行动作链',
      effective: false,
    })
    expect(options).toHaveLength(3)
  })

  it('当前值仍在清单里时不重复补占位', () => {
    expect(listFlowBindingOptions(FLOWS, 'f2').map((option) => option.value)).toEqual([
      'f1',
      'f2',
    ])
  })

  it('没有当前值时就是原样的清单', () => {
    expect(listFlowBindingOptions([])).toEqual([])
  })
})

describe('flowBindingSummary', () => {
  it('没绑时返回空串，调用据此不显示角标', () => {
    expect(flowBindingSummary(FLOWS, undefined)).toBe('')
  })

  it('已发布的图只报名字', () => {
    expect(flowBindingSummary(FLOWS, 'f1')).toBe('流程「审批」')
  })

  it('草稿与已删除都写进文案，不留给读者猜', () => {
    expect(flowBindingSummary(FLOWS, 'f2')).toBe('流程「还在画」（草稿）')
    expect(flowBindingSummary(FLOWS, 'ghost')).toBe('流程图 ghost（已不存在）')
  })
})
