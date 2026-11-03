/**
 * 架构（Schema）模块统一导出入口
 *
 * 本包只包含类型、常量与纯函数，可被内核、契约层、插件、运行时共同依赖；
 * 不依赖 Vue、DOM，也不持有任何运行时状态。
 */

// -------------------- 节点 -------------------- //
export type {
  ComponentPropsMap,
  DefaultComponentPropsMap,
  Directive,
  EventBindingValue,
  LoopConfig,
  NodeProps,
  NodeSchema,
  NodeSchemaBase,
} from './node'

// -------------------- 页面与文档 -------------------- //
export type {
  PageMeta,
  PageRouteSchema,
  PageSchema,
  PageVariableSchema,
  RouteFieldSchema,
} from './page'
export type { CreateDocumentInput, DocumentModel } from './document'
export { cloneSchema, createDocument } from './document'
export type { DataSourceRuntimeState } from './page-data'
export { buildPageData, resolveDataSourceValue } from './page-data'

// -------------------- 组件 -------------------- //
export type { ComponentMeta, ComponentSchema, SnippetSchema } from './component'

// -------------------- 属性 -------------------- //
export type { PropDefinition, PropOption, PropType, PropValue } from './props'

// -------------------- 事件 -------------------- //
export type {
  ActionHandlerDef,
  ChainHandlerDef,
  EventChain,
  EventChainStep,
  EventDefinition,
  EventHandlerDef,
  EventParameter,
} from './events'

// -------------------- 事件与动作 -------------------- //
export type {
  ActionDeclaration,
  ActionDefinition,
  ActionFieldSchema,
  EventConnection,
  PageEventName,
} from './actions'
export {
  BUILTIN_ACTIONS,
  PAGE_EVENTS,
  PAGE_EVENT_SOURCE,
  findActionDefinition,
} from './actions'

// -------------------- 表达式 -------------------- //
export type {
  CompiledExpression,
  ExpressionArrayNode,
  ExpressionArrowNode,
  ExpressionAst,
  ExpressionBinaryNode,
  ExpressionBinaryOp,
  ExpressionCallNode,
  ExpressionConditionalNode,
  ExpressionEngine,
  ExpressionIdentifierNode,
  ExpressionIndexNode,
  ExpressionLiteralNode,
  ExpressionLogicalNode,
  ExpressionLogicalOp,
  ExpressionMemberNode,
  ExpressionNode,
  ExpressionObjectNode,
  ExpressionScope,
  ExpressionString,
  ExpressionUnaryNode,
  ExpressionUnaryOp,
  JsExpression,
} from './expression'
export {
  createExpression,
  createJsExpression,
  isExpressionString,
  isJsExpression,
} from './expression'

// -------------------- 声明式函数 -------------------- //
export type {
  FunctionDescriptor,
  FunctionRegistration,
  FunctionRegistry,
  FunctionSchema,
  FunctionScopeLevel,
  ValueTypeKind,
  ValueTypeSchema,
} from './functions'

// -------------------- 数据源 -------------------- //
export type {
  CacheConfig,
  CacheStrategy,
  DataSourceConfig,
  DataSourceSchemaDef,
  DataSourceType,
  DedupeTransform,
  ExpressionTransform,
  FilterTransform,
  FlattenTransform,
  GraphQLConfig,
  GroupByTransform,
  LocalStorageConfig,
  MapTransform,
  MockConfig,
  OmitTransform,
  PathTransform,
  PickTransform,
  RestConfig,
  SortTransform,
  StaticConfig,
  TransformConfig,
} from './datasource'

// -------------------- 生命周期与插槽 -------------------- //
export type { LifecycleEvent, LifecycleSchema } from './lifecycle'
export type { SlotDefinition } from './slots'

// -------------------- 样式与布局 -------------------- //
export type {
  BorderValue,
  CSSValue,
  LayoutConstraints,
  LayoutSchema,
  Position,
  Rect,
  Size,
  SpacingValue,
  StyleSchema,
} from './styles'

// -------------------- 节点树操作 -------------------- //
export type { GroupResult, NodeFlagChange, NodePosition, OrderMode, OutlineItem } from './tree'
export {
  buildOutlineTree,
  changeOrders,
  childRefs,
  collectSubtree,
  detachFromParents,
  findPosition,
  groupNodes,
  paintOrder,
  reorderChildren,
  renameNode,
  setNodeFlags,
  ungroupNodes,
} from './tree'

// -------------------- 补丁 / 校验 / 迁移 -------------------- //
export type { SchemaPatch, SchemaPatchOp, SchemaPatches } from './patch'
export {
  actionPath,
  applyPatches,
  applySchemaPatches,
  connectionPath,
  createNodeLayoutPatch,
  getAtPath,
  isNodePatch,
  nodeEventPath,
  nodePath,
} from './patch'

export type { ValidationIssue, ValidationSeverity } from './validate'
export { hasBlockingIssue, validateDocument } from './validate'

export type { SchemaMigration } from './migrate'
export { migrateDocument } from './migrate'

// -------------------- 版本 -------------------- //
export { compareSchemaVersion, SCHEMA_VERSION } from './version'
