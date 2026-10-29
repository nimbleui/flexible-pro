/**
 * JSON Schema 的宽类型。
 *
 * 契约层不引入完整 JSON Schema 类型库：设置项、物料属性描述只需要
 * 「可 JSON 序列化的对象」，具体校验由对应服务实现负责。
 */
export type JsonSchema = Record<string, unknown>
