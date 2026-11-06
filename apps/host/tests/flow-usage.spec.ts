import { describe, expect, it } from 'vitest'
import type { EventConnection, PageSchema } from '@lc/schema'
import { SCHEMA_VERSION } from '@lc/schema'
import { findFlowUsages } from '../src/components/flow/utils/flow-usage'

/** 只填必要字段的页面 */
function makePage(
  id: string,
  title: string,
  connections: PageSchema['connections'],
): { id: string; title: string; schema: PageSchema } {
  return {
    id,
    title,
    schema: {
      version: SCHEMA_VERSION,
      nodeId: 'root',
      nodes: {
        root: { id: 'root', componentName: 'Box', children: ['btn'] },
        btn: { id: 'btn', componentName: 'Button', name: '提交按钮' },
      },
      components: [],
      connections,
    },
  }
}

function makeConnection(
  id: string,
  sourceNodeId: string,
  eventName: string,
  flowId: string,
  enabled = true,
): EventConnection {
  return { id, sourceNodeId, eventName, actionIds: [], flowId, enabled }
}

describe('findFlowUsages', () => {
  it('按页面顺序列出引用了这张图的事件，并带上可读的页面与节点名', () => {
    const usages = findFlowUsages(
      [
        makePage('p1', '工单管理', {
          c1: makeConnection('c1', 'btn', 'click', 'f1'),
        }),
        makePage('p2', '事件演示', {
          c2: makeConnection('c2', 'btn', 'click', 'other'),
          c3: makeConnection('c3', 'page', 'pageLoad', 'f1'),
        }),
      ],
      'f1',
    )

    expect(usages).toEqual([
      {
        documentId: 'p1',
        documentTitle: '工单管理',
        sourceNodeId: 'btn',
        nodeLabel: '提交按钮',
        eventName: 'click',
        effective: true,
      },
      {
        documentId: 'p2',
        documentTitle: '事件演示',
        sourceNodeId: 'page',
        nodeLabel: '页面级事件',
        eventName: 'pageLoad',
        effective: true,
      },
    ])
  })

  it('一张图被多个事件引用时全部列出', () => {
    // 绑定改成页面持有之后，一图多绑是正常用法（同一个审批链被两个按钮唤起），不是冲突
    const usages = findFlowUsages(
      [
        makePage('p1', '页面', {
          c1: makeConnection('c1', 'btn', 'click', 'f1'),
          c2: makeConnection('c2', 'btn', 'blur', 'f1'),
        }),
      ],
      'f1',
    )

    expect(usages.map((usage) => usage.eventName)).toEqual(['click', 'blur'])
  })

  it('停用的连接仍然算引用，但标成不生效', () => {
    const usages = findFlowUsages(
      [makePage('p1', '页面', { c1: makeConnection('c1', 'btn', 'click', 'f1', false) })],
      'f1',
    )

    expect(usages[0]?.effective).toBe(false)
  })

  it('来源节点已被删除时仍报出引用，并说明节点不在了', () => {
    const page = makePage('p1', '页面', {
      c1: makeConnection('c1', 'gone', 'click', 'f1'),
    })
    const usages = findFlowUsages([page], 'f1')

    expect(usages[0]?.nodeLabel).toBe('已删除节点 gone')
  })

  it('没有页面引用时返回空数组', () => {
    expect(
      findFlowUsages(
        [makePage('p1', '页面', { c1: makeConnection('c1', 'btn', 'click', 'f2') })],
        'f1',
      ),
    ).toEqual([])
  })

  it('没有连接表的页面不参与扫描', () => {
    const page = makePage('p1', '页面', undefined)

    expect(findFlowUsages([page], 'f1')).toEqual([])
  })
})
