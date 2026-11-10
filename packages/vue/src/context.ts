import type { App, ComputedRef, InjectionKey, Ref } from 'vue'
import { computed, inject, onUnmounted, ref, shallowRef, watchEffect } from 'vue'
import type { Context, Disposable } from '@lc/kernel'
import type { Registry } from '@lc/contracts'

/**
 * 低代码 Context 的全局注入键名。
 *
 * 带命名空间与结构版本：宿主与远程各自打包一份 @lc/vue 时，两边的
 * `Symbol.for(LC_CONTEXT_KEY)` 必须落到 global symbol registry 的同一项上，
 * 所以键名只能在一份源码里定义并由双方共用。无命名空间的裸键还可能被同页
 * 第二个宿主实例、第二个远程或第三方脚本占用；`v1` 表示 Context 形状版本，
 * 结构不兼容时递增版本，让新旧副本取到不同键，而不是静默拿到残缺的 Context。
 *
 * 宿主与远程一律通过本常量或 `LC_CONTEXT` 取值，不要各自硬编码该字符串。
 */
export const LC_CONTEXT_KEY = '@lc/context/v1'

/**
 * 低代码 Context 的 Vue 注入键。
 *
 * 必须用 `Symbol.for`：宿主与远程模块各自打包一份 @lc/vue 时，`Symbol()` 会产生
 * 两个互不相等的键，远程侧登记的画布覆盖层组件便注入不到宿主 provide 的上下文。
 */
export const LC_CONTEXT: InjectionKey<Context> = Symbol.for(
  LC_CONTEXT_KEY,
) as InjectionKey<Context>

/**
 * 把低代码 Context 注入到 Vue 应用根部。
 *
 * 只在根应用调用一次；面板、覆盖层、画布组件通过 `useAppContext` 获取。
 */
export function provideContext(app: App, context: Context): void {
  app.provide(LC_CONTEXT, context)
}

/**
 * Context 形状的最小校验面。
 *
 * 只检查所有覆盖层 / 面板组件都会调用的三个方法，不做完整运行时类型校验：
 * 目的是在宿主 v1 与远程 v2 结构不兼容、或第三方脚本往同名键里塞了无关对象时，
 * 让错误在注入点就明确报出，而不是等到 `ctx.get` / `ctx.provide` 处变成
 * 无法定位的 undefined 或 TypeError。
 */
function hasContextShape(value: unknown): value is Context {
  if (typeof value !== 'object' || value === null) return false
  return (
    'get' in value &&
    typeof value.get === 'function' &&
    'provide' in value &&
    typeof value.provide === 'function' &&
    'require' in value &&
    typeof value.require === 'function'
  )
}

/**
 * 取当前低代码 Context；未注入或注入值形状不兼容时直接抛错，避免静默拿到 undefined。
 */
export function useAppContext(): Context {
  const context: unknown = inject(LC_CONTEXT, null)
  if (!hasContextShape(context)) {
    throw new Error(
      `[lc] 未找到兼容的低代码 Context（键 ${LC_CONTEXT_KEY}）：请在根应用调用 ` +
        'provideContext，并确认宿主与远程使用同一 @lc/vue 版本',
    )
  }
  return context
}

/**
 * 响应式读取服务实例。
 *
 * 服务可能晚于组件出现（Realm 装载、晚绑定），因此返回 Ref 并在
 * `services.onDidChange` 时刷新；组件卸载自动解绑。
 */
export function useService<K extends keyof Context & string>(
  name: K,
): Ref<Context[K] | undefined> {
  const context = useAppContext()
  const value = shallowRef(context.get<Context[K]>(name))

  // 只订阅本名的变化：服务表里任何一次注册都会回调，逐名订阅会累加无效监听
  const off = context.services.onDidChange((changed) => {
    if (changed === name) value.value = context.get<Context[K]>(name)
  })
  onUnmounted(off.dispose)

  // 服务可能尚未注册，对外类型必须可空；这里的断言只为对齐 shallowRef 的推断结果，
  // 不改变运行时取值
  return value as Ref<Context[K] | undefined>
}

/**
 * 把注册表桥接为响应式列表。
 *
 * 只依赖 `version` 与 `onDidChange`，不做深度代理；注册表条目本身
 * 保持引用稳定，避免画布高频更新时产生额外开销。
 */
export function useRegistryList<T>(
  getRegistry: () => Registry<T> | undefined,
): ComputedRef<readonly T[]> {
  const version = ref(0)
  let off: Disposable | null = null

  // getRegistry 的依赖变化（例如服务实例被替换）时重新订阅：
  // 先释放旧订阅再挂新的，避免同一个变更被累加多次触发
  const stop = watchEffect(() => {
    off?.dispose()
    const registry = getRegistry()
    off = registry
      ? registry.onDidChange(() => {
          version.value += 1
        })
      : null
  })

  onUnmounted(() => {
    stop()
    off?.dispose()
  })

  return computed(() => {
    version.value
    const registry = getRegistry()
    if (!registry) return []
    // 读取 version 让 computed 跟踪注册表变化
    void registry.version
    return registry.list()
  })
}
