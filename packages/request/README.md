# @lc/request

基于 axios 的轻量请求封装：把重复的动态参数、数据解包、业务 code 判定与错误回调收拢进一个 `createRequest` 工厂。

## 设计约定

| 约定                 | 说明                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `B` 从哪来           | 在 `createRequest<B>()` 上锁定，调用时用 `request(config, baseData)` 传入                                         |
| `before` 返回 false  | Promise 解析为 `undefined`，不 reject；调用方需处理这个分支                                                       |
| `success(data, ret)` | `data` 是解包并格式化后的业务数据；`ret` 是未解包的完整响应体                                                     |
| `format`             | 在解包之后、`success` 之前执行；Promise 结果、`success` 的第一个参数都是格式化后的值                              |
| `error` 之后         | 仍会 reject `RequestError`，回调只是副作用                                                                        |
| `errType`            | 无有效响应（网络/超时/配置错误）为 `catch`；服务端返回但 HTTP 状态或业务 code 失败为 `response`                   |
| `excludeCode`        | 命中时 `RequestError.isExclude === true`，请求级 `error` 仍执行，实例级 `onError` 跳过                            |
| `dataPath`           | 默认 `'data'`，支持 `data.list` 点语法；`false` 返回完整响应体；`true` 等价默认值                                 |
| `includeCode`        | 默认 `['0', '200']`；响应中没有 code 字段一律视为成功；code 判定先于 dataPath 解包                                |
| `netType`            | 是实例配置 `baseURLs` 的键，用于取对应 baseURL；类型受键约束，写错编译期报错。单次请求的原生 `baseURL` 优先于映射 |

## 用法

```ts
import { createRequest } from '@lc/request'

interface BaseData {
  tenantId: string
}

interface User {
  id: string
  name: string
}

const request = createRequest<BaseData>({
  axiosConfig: { timeout: 10000 },
  baseURLs: {
    api: 'https://api.example.com',
    admin: 'https://admin.example.com',
  },
  netType: 'api',
  onError: (error) => console.warn(error.message),
})

const user = await request<User>(
  {
    url: '/user/detail',
    method: (baseData) => (baseData.tenantId ? 'POST' : 'GET'),
    data: (baseData) => ({ tenantId: baseData.tenantId }),
    params: { from: 'app' },
    dataPath: 'data.user',
    success: (data, ret) => console.log(data, ret.code),
  },
  { tenantId: 't-1' },
)
// user 类型为 Record<string, unknown> & User 或 undefined
```

`before` 终止请求：

```ts
const result = await request<User>({
  url: '/user/detail',
  before: ({ data }) => data === undefined,
})

if (result === undefined) {
  // 被 before 拦下，未发出请求
}
```

## 全局配置：拦截器 / token / 公共配置（配一次）

在应用入口用 `configureRequest` 配置一次，之后所有 `createApis` 默认复用同一份实例，不用每个 API 文件重复 `createRequest`、重复注册拦截器。

```ts
// request.setup.ts —— 应用入口，只执行一次
import { configureRequest } from '@lc/request'
import { getToken } from './auth' // 项目自己的 token 读取方法

configureRequest({
  axiosConfig: { timeout: 10000 },
  baseURLs: {
    api: 'https://api.example.com',
    admin: 'https://admin.example.com',
  },
  interceptors: {
    // 请求前拦截：统一注入 token
    request: (config) => {
      const token = getToken()
      if (token) config.headers.set('Authorization', `Bearer ${token}`)
      return config
    },
    requestError: (error) => Promise.reject(error),

    // 响应拦截：可统一预处理原始响应
    response: (response) => response,
    responseError: (error) => {
      // 例：401 跳登录；返回 Promise.reject 继续走错误流程
      return Promise.reject(error)
    },
  },
  onError: (error) => console.warn(error.message),
})
```

拦截器注册在 axios 实例上，**对所有复用该实例的请求生效**。签名约定：

| 拦截器          | 时机                     | 返回值的意义                               |
| --------------- | ------------------------ | ------------------------------------------ |
| `request`       | 请求发出前               | 返回修改后的 config；抛错中断请求          |
| `requestError`  | 请求拦截器抛错时         | 返回值继续传递，抛错则中断                 |
| `response`      | 响应到达、本封装解析之前 | 返回修改后的 `AxiosResponse`               |
| `responseError` | HTTP 或网络错误时        | 可恢复为完整 `AxiosResponse` 或继续 reject |

> `responseError` 若要恢复错误，返回值必须是完整的 `AxiosResponse`（含 `data` 信封），否则后续的 code 判定与 `dataPath` 解包拿不到预期结构。

取用全局实例或重置（测试用）：

```ts
import { getRequest, resetRequest } from '@lc/request'

const request = getRequest() // 未配置时会惰性创建空配置实例
resetRequest() // 仅供测试隔离，生产代码不要用
```

## 配置独立成文件 + 批量创建 API

当接口很多时，把「方法名 -> 请求配置」单独放一个文件（如 `approval.api.ts`），业务侧用 `createApis` 一次生成所有方法。配置里的 `data/params/method` 写成函数时，入参就是调用方法时传的数据，可据此动态改 url、请求体。

```ts
// approval.api.ts —— 只描述配置，不含调用
import { createApis } from '@lc/request'

export const approvalApis = createApis({
  /** 发起审批流程：用传入的数据动态决定 url */
  customApproval: {
    url: '',
    before: ({ config, data }) => {
      config.url = data as string
    },
    data: (params) => params,
  },

  /** 阶段图形 */
  getStagedetailBySceneAndSceneDataId: {
    url: '/project-server/stagedetail/getStagedetailBySceneAndSceneDataId',
    data: (params) => params,
  },

  /** 查询审批场景是否开启 */
  verifyCompanySceneByCode: {
    url: '/system-server/companyscenesetting/verifyCompanySceneByCode',
    data: (params) => params,
  },
})
// 注意：未传第二个参数，复用 configureRequest 配置的全局实例（含 token、拦截器、baseURLs）。
```

```ts
// 业务侧直接调用，无需重复写配置
import { approvalApis } from './approval.api'

await approvalApis.customApproval('/workflow/start')
await approvalApis.getStagedetailBySceneAndSceneDataId({ id: '1' })
```

`createApis` 的第二个参数决定用哪个实例：

| 传参                                   | 行为                                                  |
| -------------------------------------- | ----------------------------------------------------- |
| 不传                                   | 复用全局共享实例（推荐，公共配置只配一次）            |
| 传 `RequestDefaults`                   | 创建独立实例（不同域名 / 不同全局错误处理，互不影响） |
| 传 `configureRequest` 返回的 `request` | 使用指定实例，并保留 netType 的键类型约束             |

说明：

- 方法名、参数、返回类型都由配置推导：用 `satisfies ApiConfigMap` 声明配置可让类型更精确。
- `netType` 的合法取值 = `baseURLs` 的键。传 `defaults` 或带类型的 `request` 时，会从 `baseURLs` 推导键集合并约束所有 `netType`，写错（未配置的别名）会在编译期报错：

  ```ts
  const globalRequest = configureRequest({
    baseURLs: { api: 'https://api.example.com', admin: 'https://admin.example.com' },
  })
  const apis = createApis({ a: { url: '/a', netType: 'api' } }, globalRequest)
  // netType: 'api' | 'admin' ✅；'other' ❌ 编译错误（不在 baseURLs 键中）
  ```

  > 不传第二个参数（复用全局实例）时静态键约束退化为 `string`，因为全局槽位无法在调用点推导键集合；需要约束时就传入带类型的 `request`。同理，显式写 `createRequest<B>(...)` 的第一个泛型 B 时 N 也会退化，需写全 `createRequest<B, 'api' | 'admin'>(...)`。

## 未包含的能力

重试、防重复提交、loading 状态、统一错误码文案映射不在本次范围，需要产品决策（重试策略、提示形式、并发语义）。请求/响应拦截器、token 注入已通过 `interceptors` 支持；取消与超时可用 axios 原生 `signal`/`timeout`。
