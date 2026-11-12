import type { ProjectApi } from '@lc/schema'
import type { ApiScopeConfig } from './api-config-model'

/**
 * 内置接口与环境种子。
 *
 * 只在**首次运行**补一次（空库且未置初始化标记），之后就是普通记录：可以改、可以删，
 * 删空不再补种——与 `flow-store` 同一取舍。种子让接口管理页第一次打开就有可核对的
 * 示例（用户 / 订单 / 商品 / 文件四组），而不是对着空表猜每个字段该怎么填。
 *
 * 域名用 example.com：种子接口没有被任何页面绑定，不会真的发出请求；使用者改成
 * 自己的域名后，相对路径的接口即按新环境拼接。
 */

/** 示例接口；id 固定，便于演示文档或外部链接稳定引用 */
export function createBuiltinApiSeeds(): ProjectApi[] {
  const now = new Date().toISOString()

  const base = { createdAt: now, updatedAt: now }

  return [
    {
      ...base,
      id: 'api-user-info',
      name: '获取用户信息',
      group: '用户管理',
      description: '获取当前登录用户的基本信息，包含用户信息、角色等',
      tags: ['用户', '信息'],
      method: 'GET',
      path: '/api/user/info',
      headers: { 'Content-Type': 'application/json' },
      params: { userId: '' },
      paramMeta: { userId: { required: true, description: '用户ID' } },
      sample: { code: 0, data: { id: 1, name: 'Tom', roles: ['admin'] } },
    },
    {
      ...base,
      id: 'api-order-create',
      name: '创建订单',
      group: '订单管理',
      description: '提交商品与数量，创建一笔新订单',
      tags: ['订单'],
      method: 'POST',
      path: '/api/order/create',
      body: { goodsId: 1, quantity: 2 },
    },
    {
      ...base,
      id: 'api-order-update',
      name: '更新订单',
      group: '订单管理',
      description: '修改订单的收货信息与商品数量',
      tags: ['订单'],
      method: 'PUT',
      path: '/api/order/update',
      body: { orderId: 'O-1001', quantity: 3 },
    },
    {
      ...base,
      id: 'api-order-delete',
      name: '删除订单',
      group: '订单管理',
      description: '按订单号删除一笔未支付订单',
      tags: ['订单'],
      method: 'DELETE',
      path: '/api/order/delete',
      params: { orderId: '' },
      paramMeta: { orderId: { required: true, description: '订单号' } },
    },
    {
      ...base,
      id: 'api-goods-list',
      name: '获取商品列表',
      group: '商品管理',
      description: '分页获取在售商品',
      tags: ['商品'],
      method: 'GET',
      path: '/api/goods/list',
      params: { page: '1', size: '20' },
      paramMeta: {
        page: { type: 'number', description: '页码，从 1 开始' },
        size: { type: 'number', description: '每页条数' },
      },
    },
    {
      ...base,
      id: 'api-goods-detail',
      name: '获取商品详情',
      group: '商品管理',
      description: '按商品 id 获取详情与库存',
      tags: ['商品'],
      method: 'GET',
      path: '/api/goods/detail',
      params: { goodsId: '' },
      paramMeta: { goodsId: { required: true, description: '商品ID' } },
    },
    {
      ...base,
      id: 'api-file-upload',
      name: '上传文件',
      group: '文件管理',
      description: '上传附件，返回文件地址',
      tags: ['文件'],
      method: 'POST',
      path: '/api/file/upload',
    },
  ]
}

/** 示例环境：开发 / 测试 / 生产三套，开发环境生效 */
export function createBuiltinEnvironmentSeed(): ApiScopeConfig {
  return {
    activeEnvId: 'env-dev',
    environments: [
      {
        id: 'env-dev',
        name: '开发环境',
        baseUrl: 'https://dev-api.example.com',
        withCredentials: true,
        responseHeaders: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Token',
        },
      },
      { id: 'env-test', name: '测试环境', baseUrl: 'https://test-api.example.com' },
      { id: 'env-prod', name: '生产环境', baseUrl: 'https://api.example.com' },
    ],
  }
}
