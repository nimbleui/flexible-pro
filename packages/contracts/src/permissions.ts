/**
 * 静态权限声明。
 *
 * 这里描述的是「manifest 申请什么能力」，不负责运行时决策；
 * 运行时「当前用户 + 当前插件 + 当前环境能不能做某动作」由 permission 服务
 * 与 policy 服务共同决定（骨架阶段未实现，契约先行）。
 */
export type Permission =
  | {
      /** 出站网络访问 */
      type: 'network'
      /** 允许访问的主机名；空数组表示全部拒绝 */
      hosts: string[]
    }
  | {
      /** 浏览器/命名空间存储 */
      type: 'storage'
    }
  | {
      /** 剪贴板读写 */
      type: 'clipboard'
    }

/** 权限风险等级，用于安装确认弹窗排序 */
export type PermissionRisk = 'low' | 'medium' | 'high'
