import type { NavigationService } from '@lc/contracts'
import { router } from './router'

/**
 * 宿主路由适配。
 *
 * `navigation.go` 动作落到真实的 vue-router 上。平台侧不持有路由实例，所以动作在
 * 预览页与真实业务页里各跳各的路由——这也是把它做成服务而不是直接 import router
 * 的原因：`@lc/schema` 与执行器必须不认识宿主的路由对象。
 */
export const navigationService: NavigationService = {
  go(to, options) {
    /**
     * 返回值刻意不 await 也不上报。
     *
     * vue-router 在「导航被守卫拦下」时也 reject，而守卫拦截是正常业务结果，
     * 不该冒泡成一条动作失败——否则每个带路由守卫的页面都会误报错误。
     * 路径写错这类问题由跳转后落到 404 暴露，比在这里吞掉的信号更直观。
     */
    const pending = options?.replace ? router.replace(to) : router.push(to)
    void pending.catch(() => undefined)
  },
}
