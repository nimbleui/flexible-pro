import type {
  ActionHandler,
  ActionRunResult,
  ActionService,
  ActionStepRecord,
} from '@lc/contracts'
import { defineEditorPlugin } from '@lc/contracts'
import type { ActionEventPayload } from '@lc/contracts'
import type { Disposable } from '@lc/kernel'
import type { ExpressionScope } from '@lc/schema'
import { buildExpressionScope } from '@lc/schema'
import { runActionChain } from './runner'
import { FLOW_HANDLERS } from './flow-handlers'
import { createBusinessHandlers } from './handlers'

/**
 * 动作执行器插件（Realm 级）。
 *
 * 把 `PageSchema.connections` + `PageSchema.actions` 从「可编辑的声明」变成「能跑的链」。
 * 状态属于文档 Realm：链上的动作写的是本文档的状态服务，切换文档不能串台。
 *
 * 作用域每次执行动作时重新装配，而不是整条链装配一次——`state.set` 之后
 * 后续动作的条件必须读到新值。这是本插件存在的一个关键约束，改作用域装配时不要退化成快照。
 */
export default defineEditorPlugin({
  name: 'service-action',
  inject: ['document', 'expression', 'pageState', 'dataSource'],

  apply(ctx) {
    const document = ctx.document
    const handlers = new Map<string, ActionHandler>()
    const listeners = new Set<(record: ActionStepRecord) => void>()
    let scopeProvider: (() => ExpressionScope) | undefined
    let disposed = false

    for (const handler of FLOW_HANDLERS) handlers.set(handler.type, handler)

    /**
     * 业务动作处理器。
     *
     * `toast` / `navigation` 用 getter 而不是取值传入：它们是宿主在应用级注册的能力，
     * 可能晚于本 Realm 建立。状态与数据源由 `inject` 保证已存在，可以按值传。
     */
    for (const handler of createBusinessHandlers({
      pageState: ctx.pageState,
      dataSource: ctx.dataSource,
      getService: (name) => ctx.get(name),
      get toast() {
        return ctx.toast
      },
      get navigation() {
        return ctx.navigation
      },
    })) {
      handlers.set(handler.type, handler)
    }

    /**
     * 注册处理器，同类型后者覆盖前者。
     *
     * dispose 只在句柄仍指向自己这个处理器时移除：内置处理器与插件处理器可能先后
     * 注册同一类型，晚注册的那个不应该被先注册者的 dispose 顶掉。
     */
    function register(handler: ActionHandler): Disposable {
      handlers.set(handler.type, handler)
      return {
        dispose: () => {
          if (handlers.get(handler.type) === handler) handlers.delete(handler.type)
        },
      }
    }

    function createScope(event?: ActionEventPayload): ExpressionScope {
      return buildExpressionScope({
        schema: document.model.schema,
        dataSources: ctx.dataSource.states(),
        variables: ctx.pageState.snapshot(),
        event,
        base: scopeProvider?.(),
      })
    }

    function notify(record: ActionStepRecord): void {
      for (const listener of [...listeners]) listener(record)
    }

    /** 连接表里匹配某个事件键、且已启用的连接 id */
    function matchingConnections(sourceNodeId: string, eventName: string): string[] {
      const connections = document.model.schema.connections ?? {}

      return Object.values(connections)
        .filter(
          (connection) =>
            connection.enabled &&
            connection.sourceNodeId === sourceNodeId &&
            connection.eventName === eventName,
        )
        .map((connection) => connection.id)
    }

    async function run(
      connectionId: string,
      event?: ActionEventPayload,
    ): Promise<ActionRunResult> {
      const connection = document.model.schema.connections?.[connectionId]
      if (!connection) {
        return {
          status: 'failed',
          steps: 0,
          actionId: connectionId,
          message: `事件连接 "${connectionId}" 不存在`,
        }
      }

      return runActionChain(connection.actionIds, {
        actionOf: (actionId) => document.model.schema.actions?.[actionId],
        handlerOf: (type) => handlers.get(type),
        createScope: () => createScope(event),
        evaluateCondition: (expression, scope) =>
          ctx.expression.compile(expression.raw).evaluate(scope),
        resolveValue: (value, scope) => ctx.expression.resolveValue(value, scope),
        onStep: notify,
        isDisposed: () => disposed,
      })
    }

    const service: ActionService = {
      async trigger(sourceNodeId, eventName, event) {
        // 校验层已保证同一 `sourceNodeId:eventName` 只被一条启用的连接占用，
        // 但仍返回数组：不把这条约束写死进类型，将来放宽时调用方不用改
        const ids = matchingConnections(sourceNodeId, eventName)

        const results: ActionRunResult[] = []
        for (const id of ids) results.push(await run(id, event))

        return results
      },

      run: (connectionId, event) => run(connectionId, event),

      register,

      setScopeProvider(provider) {
        scopeProvider = provider
        return {
          dispose: () => {
            if (scopeProvider === provider) scopeProvider = undefined
          },
        }
      },

      onDidStep(listener) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
    }

    ctx.effect(() =>
      ctx.provide('action', service, {
        apiVersion: '1.0',
      }),
    )
    ctx.effect(() => ({
      dispose: () => {
        disposed = true
        handlers.clear()
        listeners.clear()
        scopeProvider = undefined
      },
    }))
  },
})

export { runActionChain, DEFAULT_STEP_LIMIT } from './runner'
export type { ActionRunnerDeps } from './runner'
export { runFlowGraph } from './flow-runner'
export type { FlowGraphRunnerDeps } from './flow-runner'
export { FLOW_HANDLERS } from './flow-handlers'
export { createBusinessHandlers } from './handlers'
export type { BusinessHandlerDeps } from './handlers'
