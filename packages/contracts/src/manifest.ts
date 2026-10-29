import type {
  CanvasFeatureContribution,
  CanvasProfileContribution,
} from './canvas-contributions'
import type { PanelContribution, ToolbarContribution } from './contribution'
import type { Permission } from './permissions'
import type { MaterialContribution } from './services/material'

/** 插件认证等级，决定可见范围与默认隔离层 */
export type CertificationTier = 'platform' | 'verified' | 'community'

/**
 * 插件执行位置。
 * - `inline`：与宿主同 realm，仅 platform / 通过 UI 评审的 verified 可用
 * - `iframe` / `worker` / `server`：非内联执行，不能贡献需要内联渲染的物料或画布插件
 */
export type ExecutionProfile = 'inline' | 'iframe' | 'worker' | 'server'

/** 声明式贡献集合；全部是纯数据，不执行插件代码即可渲染入口 */
export interface Contributions {
  /** 物料 */
  materials?: MaterialContribution[]
  /** 面板 */
  panels?: PanelContribution[]
  /** 工具栏按钮 */
  toolbar?: ToolbarContribution[]
  /** 画布能力 */
  canvasFeatures?: CanvasFeatureContribution[]
  /** 画布预设 */
  canvasProfiles?: CanvasProfileContribution[]
}

/**
 * 插件清单。
 *
 * 生产环境建议放在 `package.json` 的 `lowcode` 字段并在构建期合并版本号；
 * 签名覆盖 manifest + 制品，安装后不可变。
 */
export interface PluginManifest {
  /** 插件逻辑名，全局唯一；必须与入口导出的 definition.name 一致 */
  name: string
  /** 展示名，缺省取 name */
  displayName?: string
  /** 插件版本，semver */
  version: string
  /** 兼容的内核 API 版本范围，如 `^1.0.0` */
  engines: {
    /** 低代码内核版本范围 */
    lowcode: string
  }
  /** 入口模块（相对包根）；纯声明式插件可省略 */
  main?: string
  /** 静态依赖（服务名），用于安装提示与依赖图；运行时以 inject 为准 */
  requires?: string[]
  /** 激活事件；为空表示只注册贡献，不执行插件代码 */
  activationEvents?: string[]
  /** 声明的服务名，构建期与运行时 provide 校验 */
  provides?: string[]
  /** 申请的能力，安装时展示并由宿主强制执行 */
  permissions?: Permission[]
  /** 认证等级 @default 'community' */
  certification?: CertificationTier
  /** 执行位置 @default 'inline' */
  executionProfile?: ExecutionProfile
  /** UI 评审结论；executionProfile 为 inline 时生产环境必填 */
  uiReview?: 'inline' | 'sandboxed'
  /** 声明式贡献 */
  contributes?: Contributions
}
