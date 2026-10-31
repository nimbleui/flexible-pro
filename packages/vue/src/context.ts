import type { App, ComputedRef, InjectionKey, Ref } from 'vue'
import { computed, inject, onUnmounted, ref, shallowRef, watchEffect } from 'vue'
import type { Context, Disposable } from '@lc/kernel'
import type { Registry } from '@lc/contracts'

/**
 * 低代码 Context 的 Vue 注入键。
 *
 * 必须用 `Symbol.for`：宿主与远程模块各自打包一份 @lc/vue 时，`Symbol()` 会产生
 * 两个互不相等的键，远程侧登记的画布覆盖层组件便注入不到宿主 provide 的上下文。
 */
export const LC_CONTEXT: InjectionKey<Context> = Symbol.for(
  'lc-context',
) as InjectionKey<Context>

/**
 * 把低代码 Context 注入到 Vue 应用根部。
 *
 * 只在根应用调用一次；面板、覆盖层、画布组件通过 `useAppContext` 获取。
 */
export function provideContext(app: App, context: Context): void {
  app.provide(LC_CONTEXT, context)
}

/** 取当前低代码 Context；未注入时直接抛错，避免静默拿到 undefined。 */
export function useAppContext(): Context {
  const context = inject(LC_CONTEXT, null)
  if (!context) {
    throw new Error('[lc] 未找到低代码 Context，请在根应用调用 provideContext')
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
