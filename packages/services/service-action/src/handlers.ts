import type {
  ActionHandler,
  DataSourceService,
  NavigationService,
  StateService,
  ToastService,
  ToastLevel,
} from '@lc/contracts'
import { RESERVED_SERVICES } from '@lc/kernel'

/** 业务动作处理器的依赖；全部来自 Realm / 应用上下文，由装配层注入 */
export interface BusinessHandlerDeps {
  /** 页面状态运行时 */
  pageState: StateService
  /** 数据源运行时 */
  dataSource: DataSourceService
  /** 按名字取服务，供 `plugin.invoke` 动态派发 */
  getService(name: string): unknown
  /** 宿主提示服务；无 DOM 环境不提供 */
  toast?: ToastService
  /** 宿主路由服务 */
  navigation?: NavigationService
}

/** 提示级别候选；与 `ui.toast` 表单里的 select 选项同源 */
const TOAST_LEVELS: readonly ToastLevel[] = ['info', 'success', 'warning', 'error']

function toToastLevel(value: unknown): ToastLevel {
  return TOAST_LEVELS.find((level) => level === value) ?? 'info'
}

/**
 * 按名字取服务对象上的方法。
 *
 * 动态派发本质上无法静态定型：服务名与方法名都是用户在面板里输入的文本。
 * 这里能守住的是「取出来必须是函数」，因此用 `Record` 视图收窄而不是 `any`。
 */
function memberOf(target: unknown, name: string): unknown {
  if (typeof target !== 'object' || target === null) return undefined
  return (target as Record<string, unknown>)[name]
}

/** 读必填字符串配置；缺失时给出带动作类型的失败原因，便于日志定位 */
function requiredString(
  config: Readonly<Record<string, unknown>>,
  key: string,
  actionType: string,
): string {
  const value = config[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${actionType} 缺少必填配置 "${key}"`)
  }

  return value
}

/**
 * 内置业务动作处理器。
 *
 * 与 `flow-handlers.ts` 的分工：那份只依赖执行器给的 `runAction`，本文件的每一个都
 * 需要外部能力（状态、数据源、宿主 UI）。放在一起是因为「平台支持哪些动作类型」
 * 应该有一处完整清单，而不是散落在四个包里。
 *
 * `config` 中的表达式已由执行器解析完毕，处理器拿到的是最终值。
 */
export function createBusinessHandlers(deps: BusinessHandlerDeps): readonly ActionHandler[] {
  /** 写状态前先确认变量已声明：未声明的名字进不了表达式作用域，写入等于静默丢弃 */
  function assertDeclared(key: string): void {
    if (!deps.pageState.has(key)) {
      throw new Error(`页面未声明变量 "${key}"，写入后表达式读不到`)
    }
  }

  const stateSet: ActionHandler = {
    type: 'state.set',

    async execute({ config, action }) {
      const key = requiredString(config, 'key', action.type)
      assertDeclared(key)
      deps.pageState.set(key, config.value)
    },
  }

  const stateReset: ActionHandler = {
    type: 'state.reset',

    async execute({ config }) {
      const key = config.key
      // 留空表示重置全部，是表单里写明的语义，不是缺省兜底
      if (key === undefined || key === '') {
        deps.pageState.reset()
        return
      }

      if (typeof key !== 'string') throw new TypeError('state.reset 的 key 必须是字符串')
      assertDeclared(key)
      deps.pageState.reset(key)
    },
  }

  const dataSourceFetch: ActionHandler = {
    type: 'dataSource.fetch',

    /**
     * 触发取数并把结果写进指定变量。
     *
     * `DataSourceService.fetch` 按契约不 reject，失败只写进状态对象，所以必须主动读
     * `error`——不读的话请求失败会被当成成功，后续动作在旧数据上继续跑。
     */
    async execute({ config, action }) {
      const id = requiredString(config, 'dataSourceId', action.type)

      await deps.dataSource.fetch(id)

      const state = deps.dataSource.stateOf(id)
      if (state?.error) throw new Error(`数据源 "${id}" 取数失败：${state.error}`)

      const assignTo = config.assignTo
      if (typeof assignTo === 'string' && assignTo !== '') {
        assertDeclared(assignTo)
        deps.pageState.set(assignTo, state?.data)
      }
    },
  }

  const navigationGo: ActionHandler = {
    type: 'navigation.go',

    async execute({ config, action }) {
      if (!deps.navigation) throw new Error('当前宿主未提供路由服务，navigation.go 无法执行')

      const to = requiredString(config, 'to', action.type)
      deps.navigation.go(to, { replace: config.replace === true })
    },
  }

  const uiToast: ActionHandler = {
    type: 'ui.toast',

    async execute({ config, action }) {
      if (!deps.toast) throw new Error('当前宿主未提供提示服务，ui.toast 无法执行')

      const message = config.message
      if (message === undefined || message === '') {
        throw new Error(`${action.type} 缺少必填配置 "message"`)
      }

      // 内容字段允许写成 `{{ count }}` 这类整段表达式，解析结果可能是数字，
      // 提示组件要的是文本，因此在这里收敛
      deps.toast.show(String(message), toToastLevel(config.level))
    },
  }

  const pluginInvoke: ActionHandler = {
    type: 'plugin.invoke',

    /**
     * 按「服务名 + 方法名」调用插件服务。
     *
     * 保留服务名一律拒绝：`ServiceGrant` 只约束 `provide`，不约束 `get`，如果这里不拦，
     * 一条页面动作就能拿到 `document` 直接改文档——协议里「只按声明调用插件服务，
     * 不允许直接访问插件内部对象」靠这一行落地。
     *
     * 参数形状两种都接受：数组按位置展开，其它值作为单个参数。面板上这个字段是
     * JSON 输入，用户写 `[1, 2]` 或 `{ "id": 1 }` 都是自然写法。
     */
    async execute({ config, action }) {
      const service = requiredString(config, 'service', action.type)
      if (RESERVED_SERVICES.has(service)) {
        throw new Error(`plugin.invoke 不允许调用平台保留服务 "${service}"`)
      }

      const method = requiredString(config, 'method', action.type)
      const target = deps.getService(service)
      const callable = memberOf(target, method)
      if (typeof callable !== 'function') {
        throw new Error(`服务 "${service}" 上没有可调用的方法 "${method}"`)
      }

      const args = config.args
      const params: unknown[] = args === undefined ? [] : Array.isArray(args) ? args : [args]
      await callable.apply(target, params)
    },
  }

  return [stateSet, stateReset, dataSourceFetch, navigationGo, uiToast, pluginInvoke]
}
