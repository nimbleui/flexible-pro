/**
 * 样式（Style）架构定义
 * 本文件定义了 DSL 中的样式描述体系，包括：
 * - 通用的 CSS 值类型（CSSValue）
 * - 间距类型（SpacingValue）—— 支持简写和展开格式
 * - 边框类型（BorderValue）—— 支持字符串和结构化定义
 * - 定位与尺寸类型（Position、Size、Rect）—— 用于编辑器引擎的布局计算
 * - 完整样式架构（StyleSchema）—— 涵盖布局、盒模型、背景、字体等常用 CSS 属性
 */

/**
 * 通用 CSS 值类型
 * 大多数 CSS 属性值可以是字符串（如 "10px"、"50%"、"auto"）
 * 或者数字（如 0，默认为像素单位）。
 */
export type CSSValue = string | number

/**
 * 间距值类型
 * 用于 margin/padding 属性，支持两种格式：
 * 1. 简单字符串格式：如 "10px" 或 "10px 20px"（同 CSS 简写）
 * 2. 结构化对象格式：可分别指定上右下左四个方向的值
 */
export type SpacingValue =
  | string
  | {
      /** 上侧间距，原样写入 CSS 长度（px / rem / %），不是画布逻辑坐标；缺省表示该方向不设值 */
      top?: string
      /** 右侧间距，取值约束同 top */
      right?: string
      /** 下侧间距，取值约束同 top */
      bottom?: string
      /** 左侧间距，取值约束同 top */
      left?: string
    }

/**
 * 边框值类型
 * 用于 border 属性，支持两种格式：
 * 1. 简单字符串格式：如 "1px solid #ccc"（同 CSS 简写）
 * 2. 结构化对象格式：可分别指定宽度、样式和颜色
 */
export type BorderValue =
  | string
  | {
      /** 边框宽度，如 "1px"、"2px" */
      width?: string
      /** 边框样式：实线、虚线、点线或无边框 */
      style?: 'solid' | 'dashed' | 'dotted' | 'none'
      /** 边框颜色，支持任何合法的 CSS 颜色值 */
      color?: string
    }

/**
 * 位置坐标接口
 * 用于表示组件在编辑器中的二维空间位置。
 * 坐标系原点在画布左上角，x 轴向右为正，y 轴向下为正。
 */
export interface Position {
  /** 水平方向坐标（像素） */
  x: number
  /** 垂直方向坐标（像素） */
  y: number
}

/**
 * 尺寸接口
 * 用于表示组件或元素的宽高尺寸。
 */
export interface Size {
  /** 宽度（像素） */
  width: number
  /** 高度（像素） */
  height: number
}

/**
 * 矩形区域接口
 * 继承自 Position 和 Size，同时包含位置和尺寸信息，
 * 用于表示组件在编辑器中的完整边界盒。
 */
export interface Rect extends Position, Size {}

/**
 * 布局约束接口
 * 描述节点在其父容器尺寸变化时，水平/垂直方向的锚定与缩放行为，
 * 类似 Figma 的 Constraints。仅在 {@link LayoutSchema.mode} 为 'absolute' 时有意义。
 */
export interface LayoutConstraints {
  /**
   * 水平方向约束：
   * - 'left' / 'right' / 'center'：分别锚定到父容器左侧、右侧、水平居中
   * - 'scale'：随父容器宽度按比例缩放
   * - 'stretch'：同时固定左右间距，随父容器拉伸
   */
  horizontal?: 'left' | 'right' | 'center' | 'scale' | 'stretch'
  /**
   * 垂直方向约束：
   * - 'top' / 'bottom' / 'center'：分别锚定到父容器顶部、底部、垂直居中
   * - 'scale'：随父容器高度按比例缩放
   * - 'stretch'：同时固定上下间距，随父容器拉伸
   */
  vertical?: 'top' | 'bottom' | 'center' | 'scale' | 'stretch'
}

/**
 * 节点布局架构接口
 * 描述节点在"画布/编辑器"中的定位方式与几何信息，是一个与具体 CSS 表现层解耦的
 * 设计态数据结构。
 *
 * 注意：此处的"布局"特指"画布定位"（节点自身如何被放置），
 * 与容器组件（如 AutoLayout、Flex）props 中的"自动布局"能力（子项如何排布）是两个
 * 不同的概念，不要混淆。运行时由渲染器将本结构编译为对应的 CSS（如 position/left/top/
 * width/height）。
 */
export interface LayoutSchema {
  /**
   * 放置模式：
   * - 'flow'：跟随文档流（默认），位置由父容器布局决定，rect 通常无意义
   * - 'absolute'：画布绝对定位，位置与尺寸由 rect 决定
   */
  mode?: 'flow' | 'absolute'
  /**
   * 绝对定位下的几何信息（编辑器坐标系，单位像素）。
   * 仅在 mode 为 'absolute' 时使用；由编辑器在拖拽/缩放/吸附时维护。
   */
  rect?: Rect
  /** 旋转角度（可选，单位度） */
  rotate?: number
  /** 层级（可选），对应 CSS z-index */
  zIndex?: number
  /** 布局约束（可选），描述父容器尺寸变化时的锚定与缩放行为 */
  constraints?: LayoutConstraints
}

/**
 * 样式架构接口
 * 定义了一个节点可拥有的全部 CSS 样式属性。
 * 覆盖了布局定位（position、display）、盒模型（margin、padding、width/height）、
 * 背景颜色、文字样式、边框、阴影、透明度、层级、溢出和鼠标样式等常用属性。
 * 此外通过索引签名支持任意自定义样式属性，以保持灵活性。
 */
export interface StyleSchema {
  /** CSS display 属性，控制元素的显示类型 */
  display?: string
  /** CSS position 属性，控制元素的定位方式（static、relative、absolute、fixed、sticky） */
  position?: string
  /** 最小宽度 */
  minWidth?: CSSValue
  /** 最小高度 */
  minHeight?: CSSValue
  /** 最大宽度 */
  maxWidth?: CSSValue
  /** 最大高度 */
  maxHeight?: CSSValue
  /** 外边距 */
  margin?: SpacingValue
  /** 内边距 */
  padding?: SpacingValue
  /** 背景颜色 */
  backgroundColor?: string
  /** 文字颜色 */
  color?: string
  /** 字体大小 */
  fontSize?: string
  /** 字重（粗细），如 "normal"、"bold"、"700" */
  fontWeight?: string
  /** 文本对齐方式：left、center、right、justify */
  textAlign?: string
  /** 边框样式 */
  border?: BorderValue
  /** 圆角半径 */
  borderRadius?: string
  /** 盒阴影，遵循 CSS box-shadow 语法 */
  boxShadow?: string
  /** 透明度，0（完全透明）到 1（完全不透明） */
  opacity?: number
  /** CSS z-index 层级 */
  zIndex?: number
  /** CSS overflow 属性，控制内容溢出时的处理方式 */
  overflow?: string
  /** 鼠标悬停时的光标样式 */
  cursor?: string
  /** 索引签名：支持任意其他自定义 CSS 属性 */
  [key: string]: unknown
}
